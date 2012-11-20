/*******************************************************************************
 * @license
 * Copyright (c) 2012 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials are made 
 * available under the terms of the Eclipse Public License v1.0 
 * (http://www.eclipse.org/legal/epl-v10.html), and the Eclipse Distribution 
 * License v1.0 (http://www.eclipse.org/org/documents/edl-v10.html). 
 * 
 * Contributors: IBM Corporation - initial API and implementation
 ******************************************************************************/
/*global __dirname Buffer console process require*/
/*jslint regexp:false laxbreak:true*/

var child_process = require('child_process');
var constants = require('constants');
var fs = require('fs');
var pfs = require('promised-io/fs');
var path = require('path');
var PromisedIO = require('promised-io');
var xmldom = require('xmldom');

var Deferred = PromisedIO.Deferred;
var DOMParser = xmldom.DOMParser;
var XMLSerializer = xmldom.XMLSerializer;

var BUNDLE_WEB_FOLDER = './web/';
var IS_WINDOWS = process.platform === 'win32';

var pathToRjs = path.resolve(__dirname, 'r.js');
var pathToBuildFile = path.resolve(__dirname, process.argv[2] || './orion.build.js');
var pathToBundlesFolder = path.resolve(path.dirname(pathToBuildFile), '../bundles/');
var pathToTempDir = path.resolve(__dirname, '.temp/');

/**
 * @param {NodeList} nodeList
 * @returns {Array}
 */
function toArray(nodelist) {
	return Array.prototype.slice.call(nodelist);
}

/**
 * Pass varargs to get numbered parameters, or a single object for named parameters.
 * eg. format('${0} dollars and ${1} cents', 3, 50);
 * eg. format('${dollars} dollars and ${cents} cents', {dollars:3, cents:50});
 * @param {String} str String to format.
 * @param {varags|Object} arguments 
 */
function format(str/*, args..*/) {
	var maybeObject = arguments[1];
	var args = (maybeObject !== null && typeof maybeObject === 'object') ? maybeObject : Array.prototype.slice.call(arguments, 1);
	return str.replace(/\$\{([^}]+)\}/g, function(match, param) {
		return args[param];
	});
}

/**
 * @param {Object} [options]
 * @returns {Deferred} Doesn't reject (but perhaps it should -- TODO)
 */
function execCommand(cmd, options) {
	options = options || {};
	var d = new Deferred();
	console.log(cmd);
	child_process.exec(cmd, {
		cwd: options.cwd || pathToTempDir,
		stdio: options.stdio || 'inherit'
	}, function (error, stdout, stderr) {
		if (error) {
			console.log(error.stack || error);
		}
		if (stdout) { console.log(stdout); }
		d.resolve();
	});
	return d;
}

/**
 * Workaround for pfs.readFile() always returning Buffer
 * @see https://github.com/kriszyp/promised-io/issues/24
 */
function debuf(maybeBuf) {
	return Buffer.isBuffer(maybeBuf) ? maybeBuf.toString('utf8') : maybeBuf;
}

/**
 * @param {String} xmlFile
 */
function processFile(xmlFile) {
	var document = new DOMParser().parseFromString(xmlFile, 'application/xml');
	var targets = toArray(document.getElementsByTagName('target'));
	var requirejsTarget;
	targets.some(function(t) {
		if (t.getAttribute('name') === 'requirejs') {
			requirejsTarget = t;
			return true;
		}
	});

	if (!requirejsTarget) {
		console.log("Whoa! Couldn't find a <target name=\"requirejs\"> element in customTargets.xml");
		return new Deferred().reject();
	}
	var optimizes = toArray(requirejsTarget.getElementsByTagName('optimize')).map(function(optimize) {
		var pageDir = optimize.getAttribute('pageDir');
		var name = optimize.getAttribute('name');
		return {
			pageDir: pageDir,
			name: name,
			bundle: optimize.getAttribute('bundle'),
			pageDirPath: path.join(pathToTempDir, pageDir),
			minifiedFilePath: path.join(pathToTempDir, pageDir, 'built-' + name) + '.js',
			htmlFilePath: path.join(pathToTempDir, pageDir, name + '.html')
		};
	});
	var bundles = optimizes.map(function(op) {
		return op.bundle;
	}).filter(function(bundle, i, array) {
		return array.every(function(bundle2, j) {
			if (bundle === bundle2) {
				return i >= j;
			}
			return true;
		});
	});

	var skipCopy = false, skipOptimize = false, skipUpdateHtml = false;
	/*
	 * Build steps begin here
	 */
	return pfs.mkdir(pathToTempDir).then(function() {
		return new Deferred().resolve();
	}, function(err) {
		if (err && err.code !== 'EEXIST') {
			console.log(err.stack || err);
		}
		return new Deferred().resolve();
	}).then(function() {
		/* So. Because the file structure of the Orion source bundles doesn't match the URL/RequireJS module
		 * structure, we need to copy all the bundles' "./web/" folders into the temp dir, so that module paths
		 * can resolve successfully, and later optimization steps will work.
		 */
		if (skipCopy) { return new Deferred().resolve(); }
		console.log('-------------------------------------------------------\n' + 'Copying bundle web content to ' + pathToTempDir + '...\n');
		return PromisedIO.seq(bundles.map(function(bundle) {
			return function() {
				var bundleWebFolder = path.resolve(pathToBundlesFolder, bundle, BUNDLE_WEB_FOLDER);
				// The "cmd /c" prefix ensures Windows command processor is invoked (rather than, say, Cygwin bash)
				var cmd = IS_WINDOWS ? format('xcopy /e /h /q /y "${0}" "${1}" ', bundleWebFolder, pathToTempDir)
					: format("cp -R ${0}/* ${1}", bundleWebFolder, pathToTempDir);
				return execCommand(cmd);
			};
		}));
	}).then(function() {
		if (skipOptimize) { return new Deferred().resolve(); }
		console.log('-------------------------------------------------------\n' + 'Running optimize...\n');
		return PromisedIO.seq(optimizes.map(function(op) {
			return function() {
				// TODO better to call r.js from this node instance instead of shell cmd??
				var pageDir = op.pageDir, name = op.name;
				var cmd = format(
					"node ${pathToRjs} -o ${pathToBuildFile} name=${name} out=${out} baseUrl=${baseUrl}", {
					pathToRjs: pathToRjs, pathToBuildFile: pathToBuildFile,
					name: pageDir + '/' + name,
					out: './.temp/' + pageDir + '/built-' + name + '.js',
					baseUrl: './.temp/'
				});
				// TODO check existence of path.join(pageDir, name) -- skip if the file doesn't exist
				return execCommand(cmd, {
					cwd: path.dirname(pathToBuildFile)
				});
			};
		}));
	}).then(function() {
		if (skipUpdateHtml) { return new Deferred().resolve(); }
		console.log('-------------------------------------------------------\n' + 'Running updateHTML...\n');
		return PromisedIO.seq(optimizes.map(function(op) {
			return function() {
				// TODO stat minifiedFilePath, only perform the replace if minifiedfile.size > 0
				var name = op.name;
				var builtResult = 'require(["built-' + name + '.js"]);';
				console.log("updateHTML " + op.htmlFilePath);
				return pfs.readFile(op.htmlFilePath, 'utf8').then(function(htmlFile) {
					htmlFile = debuf(htmlFile);
					htmlFile = htmlFile.replace("require(['" + name + ".js']);", builtResult);
					htmlFile = htmlFile.replace('require(["' + name + '.js"]);', builtResult);
					htmlFile = htmlFile.replace("requirejs/require.js", "requirejs/require.min.js");
					return pfs.writeFile(op.htmlFilePath, htmlFile);
				}, function(error) {
					// log and continue
					console.log(error.stack || error);
					console.log('');
				});
			};
		}));
	}).then(function() {
		// Copy the built files from our .temp directory back to their original locations in the bundles folder
		console.log('-------------------------------------------------------\n' + 'Copy built files to ' + pathToBundlesFolder + '...\n');
		return PromisedIO.seq(optimizes.map(function(op) {
			return function() {
				var args = {
					builtJsFile: op.minifiedFilePath,
					htmlFile: op.htmlFilePath,
					originalFolder: path.join(pathToBundlesFolder, op.bundle, BUNDLE_WEB_FOLDER, op.pageDir)
				};
				if (IS_WINDOWS) {
					return PromisedIO.all([
						execCommand(format('xcopy /q /y ${builtJsFile} ${originalFolder}', args)),
						execCommand(format('xcopy /q /y ${htmlFile} ${originalFolder}', args))
					]);
				} else {
					return execCommand(format("cp ${builtJsFile} ${htmlFile} ${originalFolder}", args));
				}
			};
		}));
	}).then(function() {
		console.log('Done.');
		process.exit(0);
	});
}

function exitFail(error) {
	if (error) { console.log(error.stack || error); }
	process.exit(1);
}

function exitSuccess() { process.exit(0); }

/*
 * The fun starts here
 */
pfs.readFile(path.join(__dirname, 'customTargets.xml'), 'utf8').then(function(xml) {
	return processFile(debuf(xml));
}, exitFail).then(exitSuccess, exitFail);