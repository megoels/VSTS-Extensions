/// <reference path="./node_modules/@types/node/index.d.ts"/>

import tl = require('vsts-task-lib/task');
import * as vm from 'vso-node-api/WebApi';
import * as ba from 'vso-node-api/BuildApi';
import * as bi from 'vso-node-api/interfaces/BuildInterfaces';
import Q = require('q');

//========================================================================================================================
// get inputs
var waitTagsList = tl.getInput('waitTagsList', true);
var customAuth = tl.getBoolInput('customAuth', true);
var buildsAreInCurrentTeamProject = tl.getBoolInput('buildsAreInCurrentTeamProject', true);
var teamProjectUri = tl.getInput('teamProjectUri');
var timeout = tl.getInput('timeout');
var cancellingOnError = tl.getBoolInput('cancellingOnError');

//========================================================================================================================
// get build variables (of the running build) 
var tfsUri = tl.getVariable('System.TeamFoundationCollectionUri'); // or = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
var teamProjectName = tl.getVariable('System.TeamProject');
//var teamProjectID = tl.getVariable('System.TeamProjectId');
if (!buildsAreInCurrentTeamProject) {
    var teamProjectUriSlices = teamProjectUri.split('/');
    tfsUri = teamProjectUriSlices.slice(0, 4).join('/')
    teamProjectName = teamProjectUriSlices.slice(4, 5).join();
    if ((teamProjectUriSlices.length < 5) || (!tfsUri) || (!teamProjectName)) {
        tl.setResult(tl.TaskResult.Failed, "Error: Bad Team Project URL. Please make sure to provide valid team project URL including collection and team project, e.g: https://<ACCOUNTNAME>.visualstudio.com/DefaultCollection/<TEAMPROJECT>");
        process.exit(1);
    }
}
var currentBuildID = tl.getVariable('Build.BuildId');

//=========== Functions ==================================================================================================
function errorHandler(e: any) {
	//var error = JSON.parse(JSON.stringify(e));
	console.error("==== ERROR Occurred ====");
	var error = e.message;
	console.error("Message: " + e.message);
	console.error("Stack: " + e.stack);
	tl.setResult(tl.TaskResult.Failed, error);
}

function getAuthentication(): any {
	let serverEndpoint = tl.getPathInput('connectedServiceName');
	if (customAuth && serverEndpoint) {
		tl.debug("A custom connected service endpoint was provided");
		let auth = tl.getEndpointAuthorization(serverEndpoint, false);
		let username = auth.parameters['username'];
		let password = auth.parameters['password'];
		//let token = auth.parameters["AccessToken"];
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

function writeBuildWarning(message: string) {
	console.log("##vso[task.logissue type=warning;] " + message);
}

function writeBuildError(message: string) {
	console.log("##vso[task.logissue type=error;] " + message);
}

function lengthOfArray(arr: any) {
	var size = 0;
	arr.forEach((element: any) => {
		if (element) { size = size + 1; }
	}, this);
	return size;
}

// Wait for builds according to wait list by tag
function waitForBuilds() {
	// set timeout if exists
	if (timeout !== "" && timeout !== "0") {
		var startDate = new Date();
		var timeoutMinutesToAdd = parseInt(timeout) * 60000;
		var timeoutDate = new Date((new Date()).getTime() + timeoutMinutesToAdd);
		console.log("Started at: " + startDate);
		console.log("Timeout at: " + timeoutDate);
		console.log("Timeout = " + timeout + " (minutes)");
	}
	// init variables for results
	let buildErrors = new Array();
	let resultMessage = "The wait process completed successfully";
	let resultState: tl.TaskResult = tl.TaskResult.Succeeded;
	// create wait list for builds for the wait process, the key is build id and value is a default build status
	let buildsWaitList = new Array();
	// loop over list of tags and check if there's variable with the selected tag which contians builds for the wait process
	tl.debug("waitTagsList=" + waitTagsList);
	let triggeredEnvVar: any = null;
	let buildsToWait: any = null;
	waitTagsList.split(",").forEach(function (tag: any) {
		if (tag.startsWith(" ")) {
			tag = tag.substring(1);
		}
		if (tag.endsWith(" ")) {
			tag = tag.substring(0, tag.length - 1);
		}
		// get value of triggered builds variable (according to tag)
		triggeredEnvVar = 'System.TriggerdBuilds_' + currentBuildID + '_' + tag;
		buildsToWait = tl.getVariable(triggeredEnvVar);
		// stop processing this iteration if triggered builds list is empty
		if (!buildsToWait) {
			tl.warning("No builds found for the wait process at tag [" + tag + "]");
			return;
		}
		buildsToWait.split(",").forEach((build_id: any) => {
			if (build_id.startsWith(" ")) {
				build_id = build_id.substring(1);
			}
			if (build_id.endsWith(" ")) {
				build_id = build_id.substring(0, build_id.length - 1);
			}
			buildsWaitList[build_id] = bi.BuildStatus[bi.BuildStatus.All];
		});
	});
	// continue calling function that get status of builds until clear interval is called
	let running = false;
	var timer = setInterval(function () {
		if (running) return; // make sure one request sent each time	
		running = true;
		if (timeoutDate && ((new Date()) > timeoutDate)) { // stop waiting once timeout reached
			resultState = tl.TaskResult.Failed;
			resultMessage = "Timeout reached while waiting for builds = " + timeout + " (minutes)";
			cancellingBuilds(buildsWaitList).then(() => {
				tl.setResult(resultState, resultMessage);
				clearInterval(timer);
				timer = null;
			});
		} else {
			let buildsWaitListIsEmpty = true;
			buildsWaitListIsEmpty = buildsWaitList.every(function (): boolean { return false; });
			if (resultState === tl.TaskResult.Failed || buildsWaitListIsEmpty) { // stop waiting if failure occurred or if wait list is empty
				cancellingBuilds(buildsWaitList).then(() => {
					if (buildErrors) {
						buildErrors.forEach((err) => {
							tl.error(err);
						});
					}
					tl.setResult(resultState, resultMessage);
					clearInterval(timer);
					timer = null;
				});
			} else {
				// loop over each build on the wait list (from the environment variable)
				Object.keys(buildsWaitList).forEach(function (build_id, index) {
					return build_api.getBuild(build_id, teamProjectName).then(function (build: any) {
						// check if the build status changed (different than previous check)
						if (buildsWaitList[build_id] !== bi.BuildStatus[build.status]) {
							let build_title = "[" + build.definition.name + " / Build " + build.id + "]";
							let build_result = bi.BuildResult[build.result];
							// update the build status value of this build id
							buildsWaitList[build_id] = bi.BuildStatus[build.status];
							console.log("Build " + build_title + " = " + buildsWaitList[build_id]);
							// stop checking build if it completed	
							if (build.status === bi.BuildStatus.Completed) {
								if (build.result !== bi.BuildResult.Succeeded) { // print errors of the triggered build if it failed									
									build_api.getBuildTimeline(teamProjectName, build.id).then(function (tasks: any) {
										if (build_result) {
											tasks.records.forEach(function (tsk: any) {
												if (tsk) {
													if (((tsk.result === bi.TaskResult.Canceled) || (tsk.result === bi.TaskResult.Failed)) && (build.result !== bi.BuildResult.PartiallySucceeded)) {
														//tl.error(build_title + ": " + tsk.name + " = " + bi.TaskResult[tsk.result]);
														buildErrors.push(build_title + ": " + tsk.name + " = " + bi.TaskResult[tsk.result]);
													} else {
														if (tsk.result === bi.TaskResult.SucceededWithIssues) {
															tl.warning(build_title + ": " + tsk.name + " = " + bi.TaskResult[tsk.result]);
														}
													}
												}
											});
											// remove this build id from wait list
											delete buildsWaitList[build_id];
											for (var k in buildsWaitList) { buildsWaitList[k] = bi.BuildStatus[bi.BuildStatus.All]; }
											resultMessage = "=== The triggered build " + build_title + " " + build_result + "! ===";
											if (build.result === bi.BuildResult.PartiallySucceeded) {
												tl.warning(resultMessage);
											}
											else {
												resultState = tl.TaskResult.Failed;
											}
										}
									});
								} else {
									// remove this build id from wait list									
									delete buildsWaitList[build_id];
									for (var k in buildsWaitList) { buildsWaitList[k] = bi.BuildStatus[bi.BuildStatus.All]; }
									console.log("=== The build " + build_title + " " + build_result + " ===");
								}
							} else { console.log("Waiting..."); }
						}
						// mark the request job for rest api as finished	
						running = false;
					}).catch(function (err: any) {
						running = false;
						console.log("Warning: " + err.message);
						//errorHandler(err);
						//clearInterval(timer);
						//timer = null;
					});
				});
			}
		}
	}, 5000);
}

function cancellingBuilds(buildsToCancel: any) {
	var deferred = Q.defer();
	let listIsEmpty = buildsToCancel.every(function (): boolean { return false; });
	if (cancellingOnError && (!listIsEmpty)) {
		console.log("An error occurred: Try to cancel builds...");
		let countOfCanceledBuilds = 0;
		let countOfBuildsToCancel = lengthOfArray(buildsToCancel);
		Object.keys(buildsToCancel).forEach(function (build_id) {
			// if build not completed yet then get the build details and update the status to cancelling !
			if (buildsToCancel[build_id] !== bi.BuildStatus.Completed) {
				return build_api.getBuild(build_id, teamProjectName).then(function (build: any) {
					let build_title = "[" + build.definition.name + " / Build " + build.id + "]";
					console.log("Sending cancellation request to " + build_title + " ...");
					build.status = bi.BuildStatus.Cancelling;
					build.result = bi.BuildResult.Canceled;
					return build_api.updateBuild(build, build.id, build.project.id).then(function (res: any) {
						tl.warning("=== The triggered build " + build_title + " has been " + bi.BuildResult[res.result] + "! ===");
						countOfCanceledBuilds = countOfCanceledBuilds + 1;
						//deferred.resolve(true);
						if (countOfCanceledBuilds >= countOfBuildsToCancel) {
							deferred.resolve(true);
						}
					});
				}).catch(function (err: any) {
					//errorHandler(err);
					tl.warning("The cancelling request failed: " + err.message);
					deferred.resolve(null);
				});
			}
		});
	} else {
		deferred.resolve(null);
	}
	return deferred.promise;
}

//========================================================================================================================
// set connection variables
let collectionUrl: string = tfsUri.substring(0, tfsUri.lastIndexOf("/"));
var base_uri = collectionUrl;
//let creds = vm.getPersonalAccessTokenHandler(token);
//let creds = vm.getBasicHandler(username, password);
var http_proxy = tl.getInput('http_proxy');
var https_proxy = tl.getInput('https_proxy');
process.env.http_proxy = http_proxy;
process.env.https_proxy = https_proxy;
process.env.HTTP_PROXY = http_proxy;
process.env.HTTPS_PROXY = https_proxy;
let creds = getAuthentication();
var connection = new vm.WebApi(collectionUrl, creds);
let build_api: any = connection.getBuildApi();
//========================================================================================================================

waitForBuilds();
