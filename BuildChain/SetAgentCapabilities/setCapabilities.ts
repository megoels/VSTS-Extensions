/// <reference path="./node_modules/@types/node/index.d.ts"/>

import tl = require('vsts-task-lib/task');
import * as vm from 'vso-node-api/WebApi';
import * as ba from 'vso-node-api/BuildApi';
import * as bi from 'vso-node-api/interfaces/BuildInterfaces';
import * as tac from 'vso-node-api/TaskAgentApiBase';
import * as tai from 'vso-node-api/interfaces/TaskAgentInterfaces';
import path = require('path');
import fs = require('fs');
import Promise = require('promise');

//=========== Get Inputs =================================================================================================
var customAuth = tl.getBoolInput('customAuth', true);
//var token = auth.parameters["AccessToken"];
var capabilities = tl.getInput('capabilities');
var capabilityByBuildStatus = tl.getBoolInput('capabilityByBuildStatus');
var capabilitiesOnFailure = tl.getInput('capabilitiesOnFailure');
var capabilitiesOnSuccess = tl.getInput('capabilitiesOnSuccess');
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
		let token = null;
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

function mergeObjectsOptions(srcObject: any, extraObject: any) {
	var target = {};
	for (var attrname in srcObject) { target[attrname] = srcObject[attrname]; }
	// value of exists option will be override therefore need to make sure that first object is the one to override
	for (var attrname in extraObject) { target[attrname] = extraObject[attrname]; }
	return target;
}

function setCapabilities(userCapabilities: any) {
	// create object of capabilities
	var userCapabilitiesObj = {};
	if (userCapabilities && (userCapabilities.indexOf("=") >= 0)) {
		//var separator = "/[,;]/"
		userCapabilities.split(";").forEach((capability: any) => {
			if (capability.startsWith(" ")) { capability = capability.substring(1); }
			if (capability.endsWith(" ")) { capability = capability.substring(0, capability.length - 1); }
			var capObj = capability.split("=");
			if (capObj.length > 1) { userCapabilitiesObj[capObj[0]] = capObj[1]; }
		});
		// get pool ID
		let intBuildID = parseInt(buildID);
		return buildapi.getBuild(intBuildID, teamProjectName).then((build: any) => {
			if (build.queue.pool) {
				tl.debug("Build Pool:= " + build.queue.pool.name);
				let intAgentID = parseInt(agentID);
				tl.debug("build.queue.pool.id=" + build.queue.pool.id);
				tl.debug("intAgentID=" + intAgentID);
				return agentapi.getAgent(build.queue.pool.id, intAgentID, true, true, null).then((agent: any) => {
					if (agent) {
						tl.debug("agent.userCapabilities=" + JSON.stringify(agent.userCapabilities))
						userCapabilitiesObj = mergeObjectsOptions((agent.userCapabilities), userCapabilitiesObj);
						return agentapi.updateAgentUserCapabilities(userCapabilitiesObj, build.queue.pool.id, intAgentID).then(() => {
							console.log("The user capabilities of " + agent.name + " were updated successfully");
						});
					}
					else {
						if (!customAuth) {
							tl.warning("Wrong permissions: [VSTS] Open the Agent Pools and grant [Project Collection Build Service] admin permissions");
						}
						else {
							tl.warning("Make sure the selected Server Endpoint had permissions on the Agent Pool");
						}
						tl.setResult(tl.TaskResult.Failed, "Failed to set Agent capabilities (make sure the build user had the right permissions)!");
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
				tl.setResult(tl.TaskResult.Failed, "Failed to set Agent capabilities (make sure the build user had the right permissions)!");
			}
		}).catch(errorHandler);
	}
	else {
		tl.setResult(tl.TaskResult.Failed, "Can't set Agent capabilities, make sure the capabilities list NOT empty and in the form of capability1=value1...");
	}
}

function checkIfBuildFailed() {
	let running = false;
	return new Promise((resolve: any) => {
		var interval = setInterval(() => {
			if (running) return; // make sure one request sent each time
			// check if any build step failed...
			// we can check if the build result is not succeeded but build result could be undefined yet
			running = true;
			let intBuildID = parseInt(buildID);
			return buildapi.getBuildTimeline(teamProjectName, intBuildID).then((tasks: any) => {
				var buildFailed = false;
				// some instead of forEach, which will stop it the first time you return something non-falsy. 
				buildFailed = tasks.records.some((task: any) => {
					if (task.result === bi.TaskResult.Failed || task.result === bi.TaskResult.SucceededWithIssues) {
						console.log("The build step [" + task.name + "] = " + bi.TaskResult[task.result]);
						return true;
					}
				});
				if (buildFailed) {
					console.log("The build failed!");
					resolve(true); // true the build failed
					clearInterval(interval);
					interval = null;
				}
				else {
					running = false;
					if (tasks.records.length <= 1) return;  // at least we want to have one record on timeline to make sure we got response and info about build steps
					console.log("There's no failures on any build step");
					resolve(false); // false the build not failed
					clearInterval(interval);
					interval = null;
				}
			}).catch((err: any) => {
				resolve(true);
				errorHandler(err);
				clearInterval(interval);
				interval = null;
			});
		}, 2000);
	});
}

//=========== Execution ==================================================================================================
// set connection variables
process.env.http_proxy = http_proxy;
process.env.https_proxy = https_proxy;
process.env.HTTP_PROXY = http_proxy;
process.env.HTTPS_PROXY = https_proxy;
let collectionUrl: string = tfsUri.substring(0, tfsUri.lastIndexOf("/"));
var base_uri = collectionUrl;
// on VSTS the TeamFoundationCollectionUri is diffrent
if (tfsUri.indexOf("visualstudio.com") < 0) {
	base_uri = collectionUrl.substring(0, collectionUrl.lastIndexOf("/"));
}
let creds = getAuthentication();
var connection = new vm.WebApi(collectionUrl, creds);
let buildapi: ba.IBuildApi = connection.getBuildApi();
var agentapi: tac.ITaskAgentApiBase = connection.getTaskAgentApi(base_uri);
// set capabilities
if (capabilityByBuildStatus) {
	checkIfBuildFailed().then((failed: any) => {
		if (failed) {
			console.log("Try to set Capabilities On Failure ...");
			if (capabilitiesOnFailure) {
				setCapabilities(capabilitiesOnFailure);
			}
			else {
				tl.setResult(tl.TaskResult.Failed, "There's no capabilities to set on failure, make sure that - Capabilities On Failure - NOT empty");
			}
		}
		else {
			console.log("Try to set Capabilities On Success ...");
			if (capabilitiesOnSuccess) {
				setCapabilities(capabilitiesOnSuccess);
			}
			else {
				tl.setResult(tl.TaskResult.Failed, "There's no capabilities to set on success, make sure that - Capabilities On Success - NOT empty");
			}
		}
	});
}
else {
	setCapabilities(capabilities);
}
