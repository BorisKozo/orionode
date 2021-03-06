/*global module require*/
var fs = require('fs');
var path = require('path');
var url = require('url');
var util = require('util');
var api = require('./api');
var fileUtil = require('./fileUtil');
var resource = require('./resource');

module.exports = function(options) {
	var workspaceRoot = options.root;
	var fileRoot = options.fileRoot;
	var workspaceDir = options.workspaceDir;
	var tempDir = options.tempDir;
	if (!workspaceRoot) { throw 'options.root path required'; }

	var workspaceId = 'orionode';
	var workspaceName = 'Orionode Workspace';

	return resource(workspaceRoot, {
		GET: function(req, res, next, rest) {
			if (rest === '') {
				// http://wiki.eclipse.org/Orion/Server_API/Workspace_API#Getting_the_list_of_available_workspaces
				fileUtil.withStats(workspaceDir, function(err, stats) {
					if (err) {
						throw err;
					}
					var ws = JSON.stringify({
						Id: 'anonymous',
						Name: 'anonymous',
						UserName: 'anonymous',
						Workspaces: [{
							Id: workspaceId,
							LastModified: stats.mtime.getTime(),
							Location: api.join(workspaceRoot, workspaceId),
							Name: workspaceName
						}]
					});
					res.setHeader('Content-Type', 'application/json');
					res.setHeader('Content-Length', ws.length);
					res.end(ws);
				});
			} else if (rest === workspaceId) {
				// http://wiki.eclipse.org/Orion/Server_API/Workspace_API#Getting_workspace_metadata
				var parentFileLocation = fileRoot;
				fileUtil.getChildren(workspaceDir, parentFileLocation, [path.basename(tempDir)], function(children) {
					var ws = JSON.stringify({
						Id: workspaceId,
						Name: workspaceName,
						Location: api.join(workspaceRoot, workspaceId),
						ChildrenLocation: api.join(workspaceRoot, workspaceId), // ?? // api.join(fileRoot, workspaceId, '?depth=1'),
						Children: children
	//					Projects: [
	//						// TODO projects -- does anything care about these?
	//					]
					});
					res.setHeader('Content-Type', 'application/json');
					res.setHeader('Content-Length', ws.length);
					res.end(ws);
				});
			} else {
				res.statusCode = 400;
				res.end(util.format('workspace not found: %s', rest));
			}
		},
		POST: function(req, res, next, rest) {
			var err;
			if (rest === '') {
				// Create workspace. unsupported
				err = {Message: 'Unsupported operation: create workspace'};
				res.statusCode = 403;
				res.end(JSON.stringify(err));
			} else if (rest === workspaceId) {
				// Create project
				var projectName = req.headers.slug || (req.body && req.body.Name);
				if (!projectName) {
					err = {Message: 'Missing "Slug" header or "Name" parameter'};
					res.statusCode = 400;
					res.setHeader('Content-Type', 'application/json');
					res.end(JSON.stringify(err));
				} else {
					fs.mkdir(fileUtil.safeFilePath(workspaceDir, projectName), parseInt('0755', 8), function(error) {
						if (error) {
							err = {Message: error};
							res.statusCode = 400;
							res.end(JSON.stringify(error));
						} else {
							var newProject = JSON.stringify({
								ContentLocation: api.join(fileRoot, projectName), // Important
								Id: projectName,
								Location: api.join(workspaceRoot, 'project', projectName) // not important
								
							});
							res.statusCode = 201;
							res.setHeader('Content-Type', 'application/json');
							res.setHeader('Content-Length', newProject.length);
							res.end(newProject);
						}
					});
				}
			}
		}
	});
};
