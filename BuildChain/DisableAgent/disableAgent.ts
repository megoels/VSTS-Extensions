/// <reference path="./node_modules/@types/node/index.d.ts"/>

import tl = require('vsts-task-lib/task');
import * as vm from 'vso-node-api/WebApi';
import * as ba from 'vso-node-api/BuildApi';
import * as bi from 'vso-node-api/interfaces/BuildInterfaces';
import * as tac from 'vso-node-api/TaskAgentApiBase';
import * as tai from 'vso-node-api/interfaces/TaskAgentInterfaces';
import path = require('path');

//=========== Get Inputs =================================================================================================
var customAuth = tl.getBoolInput('customAuth', true);
// on VSTS need to set varibale for http proxy (the vso connection doesn't work if we are behind corporate proxy.)
var http_proxy = tl.getInput('http_proxy');
var https_proxy = tl.getInput('https_proxy');
//=========== Get Build Variables ========================================================================================
var tfsUri = tl.getVariable('System.TeamFoundationCollectionUri'); // or = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
var teamProjectName = tl.getVariable('System.TeamProject');
var agentID = tl.getVariable('Agent.Id');
var buildID = tl.getVariable('Build.BuildId');
var projectID = tl.getVariable('System.TeamProjectId');
var definitionID = tl.getVariable('System.DefinitionId');

//=========== Functions ==================================================================================================
function errorHandler(e: any) {
	//var error = JSON.parse(JSON.stringify(e));
	console.error("==== ERROR Occurred ====");
	console.error("Message: " + e.message);
	console.error("Stack: " + e.stack);
	tl.setResult(tl.TaskResult.Failed, e.message);
}

function getAuthentication(): any {
	let serverEndpoint = tl.getPathInput('connectedServiceName');
	if (customAuth && serverEndpoint) {
		tl.debug("A custom connected service endpoint was provided");
		let auth = tl.getEndpointAuthorization(serverEndpoint, false);
		let username = auth.parameters['username'];
		let password = auth.parameters['password'];
		//let token = auth.parameters["AccessToken"];
		//return vm.getPersonalAccessTokenHandler(token);
		return vm.getBasicHandler(username, password);
	} else {
		tl.debug("Connected Service NOT Found, try to get system OAuth Token");
		let token: any = null;
		var auth = tl.getEndpointAuthorization("SYSTEMVSSCONNECTION", false);
		if (auth.scheme === "OAuth") {
			tl.debug("Got auth token");
			token = auth.parameters["AccessToken"];
		}
		else {
			tl.debug("Could not determine credentials to use!");
		}
		if (!token) { // one more try to get System.AccessToken if token in the build Options page enabled
			token = tl.getVariable('System.AccessToken');
		}

		if (!token) {
			tl.debug("The system Oauth token is NOT present");
			let err = "Could not find System.AccessToken. Please enable the token in the build Options page (tick the box 'Allow Scripts to Access OAuth Token').";
			tl.setResult(tl.TaskResult.Failed, err);
			process.exit(1);
		}
		return vm.getBearerHandler(token);
	}
}

function disableAgent() {
	let running = false;
	let buildTimeline = false;
	var timer = setInterval(function () {
		if (running) return; // make sure one request sent each time
		// check if any build step failed...
		// we can check if the build result is not succeeded but build result could be undefined yet
		running = true;
		return buildapi.getBuildTimeline(teamProjectName, buildID).then(function (tasks: any) {
			var buildFailed = false;
			// some instead of forEach, which will stop it the first time you return something non-falsy. 
			buildFailed = tasks.records.some(function (task: any) {
				if (task.result === bi.TaskResult.Failed || task.result === bi.TaskResult.SucceededWithIssues) {
					tl.debug("The build step [" + task.name + "] = " + bi.TaskResult[task.result]);
					return true;
				}
				// at least we want to have one record on timeline to make sure we got response and info about build steps
				buildTimeline = true;
			}, this);
			if (buildFailed) {
				console.log("The build failed then Agent will be disabled");
				// get pool ID
				return buildapi.getBuild(buildID, projectID).then(function (build: bi.Build) {
					if (build.queue.pool) {
						tl.debug("Build Pool:=" + build.queue.pool.name);
						// try to disable the agent
						let intAgentID = parseInt(agentID);
						tl.debug("build.queue.pool.id=" + build.queue.pool.id);
						tl.debug("intAgentID=" + intAgentID);
						return agentapi.getAgent(build.queue.pool.id, intAgentID, true, true, null).then(function (agent: tai.TaskAgent) {
							if (agent) {
								tl.debug("Build Agent:=" + agent.name);
								agent.enabled = false;
								console.log("Disabling the Agent " + agent.name + "...");
								return agentapi.updateAgent(agent, build.queue.pool.id, intAgentID).then(function (agent: tai.TaskAgent) {
									console.log("Agent [" + agent.name + "] was successfully disabled");
									tl.setResult(tl.TaskResult.Succeeded, "Agent [" + agent.name + "] was successfully disabled");
									clearInterval(timer);
									timer = null;
								}).catch(function (err: any) {
									tl.setResult(tl.TaskResult.Failed, "Failed to disable the Agent [" + agent.name + "]: " + err);
									clearInterval(timer);
									timer = null;
								});
							}
							else {
								if (!customAuth) {
									tl.warning("Wrong permissions: [VSTS] Open the Agent Pools and grant [Project Collection Build Service] admin permissions");
								}
								else {
									tl.warning("Make sure the selected Server Endpoint had permissions on the Agent Pool");
								}
								tl.setResult(tl.TaskResult.Failed, "Failed to disable Agent (make sure the build user had the right permissions)!");
								clearInterval(timer);
								timer = null;
							}
						});
					}
					else {
						if (!customAuth) {
							tl.warning("Wrong permissions: [VSTS] Open the Agent Queues (at the team project) and grant [Project Collection Build Service] admin permissions")
						}
						else {
							tl.warning("Make sure the selected Server Endpoint had permissions on the Agent Queue");
						}
						tl.setResult(tl.TaskResult.Failed, "Failed to disable Agent (make sure the build user had the right permissions)!");
						clearInterval(timer);
						timer = null;
					}
				});
			}
			else {
				running = false;
				if (buildTimeline) {
					clearInterval(timer);
					timer = null;
					console.log("There's no failures - Agent will not be disabled");
				}
			}
		}).catch(function (err: any) {
			errorHandler(err);
			clearInterval(timer);
			timer = null;
		});
	}, 2000);
}

//=========== Execution ==================================================================================================
// set connection variables
process.env.http_proxy = http_proxy;
process.env.https_proxy = https_proxy;
process.env.HTTP_PROXY = http_proxy;
process.env.HTTPS_PROXY = https_proxy;
let collectionUrl: string = tfsUri.substring(0, tfsUri.lastIndexOf("/"));
let base_uri = collectionUrl;
// on VSTS the TeamFoundationCollectionUri is diffrent
if (tfsUri.indexOf("visualstudio.com") < 0) {
	base_uri = collectionUrl.substring(0, collectionUrl.lastIndexOf("/"));
}
let creds = getAuthentication();
let connection = new vm.WebApi(collectionUrl, creds);
//var build_api: ba.BuildApi = connection.getBuildApi();
var buildapi: any = connection.getBuildApi();
var agentapi: any = connection.getTaskAgentApi(base_uri);
// try to disable the agent
disableAgent();
