"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var tl = require("vsts-task-lib/task");
var vm = require("vso-node-api/WebApi");
var bi = require("vso-node-api/interfaces/BuildInterfaces");
var Q = require("q");
var waitTagsList = tl.getInput('waitTagsList', true);
var customAuth = tl.getBoolInput('customAuth', true);
var buildsAreInCurrentTeamProject = tl.getBoolInput('buildsAreInCurrentTeamProject', true);
var teamProjectUri = tl.getInput('teamProjectUri');
var timeout = tl.getInput('timeout');
var cancellingOnError = tl.getBoolInput('cancellingOnError');
var tfsUri = tl.getVariable('System.TeamFoundationCollectionUri');
var teamProjectName = tl.getVariable('System.TeamProject');
if (!buildsAreInCurrentTeamProject) {
    var teamProjectUriSlices = teamProjectUri.split('/');
    tfsUri = teamProjectUriSlices.slice(0, 4).join('/');
    teamProjectName = teamProjectUriSlices.slice(4, 5).join();
    if ((teamProjectUriSlices.length < 5) || (!tfsUri) || (!teamProjectName)) {
        tl.setResult(tl.TaskResult.Failed, "Error: Bad Team Project URL. Please make sure to provide valid team project URL including collection and team project, e.g: https://<ACCOUNTNAME>.visualstudio.com/DefaultCollection/<TEAMPROJECT>");
        process.exit(1);
    }
}
var currentBuildID = tl.getVariable('Build.BuildId');
function errorHandler(e) {
    console.error("==== ERROR Occurred ====");
    var error = e.message;
    console.error("Message: " + e.message);
    console.error("Stack: " + e.stack);
    tl.setResult(tl.TaskResult.Failed, error);
}
function getAuthentication() {
    var serverEndpoint = tl.getPathInput('connectedServiceName');
    if (customAuth && serverEndpoint) {
        tl.debug("A custom connected service endpoint was provided");
        var auth_1 = tl.getEndpointAuthorization(serverEndpoint, false);
        var username = auth_1.parameters['username'];
        var password = auth_1.parameters['password'];
        return vm.getBasicHandler(username, password);
    }
    else {
        tl.debug("Connected Service NOT Found, try to get system OAuth Token");
        var token = null;
        var auth = tl.getEndpointAuthorization("SYSTEMVSSCONNECTION", false);
        if (auth.scheme === "OAuth") {
            tl.debug("Got auth token");
            token = auth.parameters["AccessToken"];
        }
        else {
            tl.debug("Could not determine credentials to use!");
        }
        if (!token) {
            token = tl.getVariable('System.AccessToken');
        }
        if (!token) {
            tl.debug("The system Oauth token is NOT present");
            var err = "Could not find System.AccessToken. Please enable the token in the build Options page (tick the box 'Allow Scripts to Access OAuth Token').";
            tl.setResult(tl.TaskResult.Failed, err);
            process.exit(1);
        }
        return vm.getBearerHandler(token);
    }
}
function writeBuildWarning(message) {
    console.log("##vso[task.logissue type=warning;] " + message);
}
function writeBuildError(message) {
    console.log("##vso[task.logissue type=error;] " + message);
}
function lengthOfArray(arr) {
    var size = 0;
    arr.forEach(function (element) {
        if (element) {
            size = size + 1;
        }
    }, this);
    return size;
}
function waitForBuilds() {
    if (timeout !== "" && timeout !== "0") {
        var startDate = new Date();
        var timeoutMinutesToAdd = parseInt(timeout) * 60000;
        var timeoutDate = new Date((new Date()).getTime() + timeoutMinutesToAdd);
        console.log("Started at: " + startDate);
        console.log("Timeout at: " + timeoutDate);
        console.log("Timeout = " + timeout + " (minutes)");
    }
    var buildErrors = new Array();
    var resultMessage = "The wait process completed successfully";
    var resultState = tl.TaskResult.Succeeded;
    var buildsWaitList = new Array();
    tl.debug("waitTagsList=" + waitTagsList);
    var triggeredEnvVar = null;
    var buildsToWait = null;
    waitTagsList.split(",").forEach(function (tag) {
        if (tag.startsWith(" ")) {
            tag = tag.substring(1);
        }
        if (tag.endsWith(" ")) {
            tag = tag.substring(0, tag.length - 1);
        }
        triggeredEnvVar = 'System.TriggerdBuilds_' + currentBuildID + '_' + tag;
        buildsToWait = tl.getVariable(triggeredEnvVar);
        if (!buildsToWait) {
            tl.warning("No builds found for the wait process at tag [" + tag + "]");
            return;
        }
        buildsToWait.split(",").forEach(function (build_id) {
            if (build_id.startsWith(" ")) {
                build_id = build_id.substring(1);
            }
            if (build_id.endsWith(" ")) {
                build_id = build_id.substring(0, build_id.length - 1);
            }
            buildsWaitList[build_id] = bi.BuildStatus[bi.BuildStatus.All];
        });
    });
    var running = false;
    var timer = setInterval(function () {
        if (running)
            return;
        running = true;
        if (timeoutDate && ((new Date()) > timeoutDate)) {
            resultState = tl.TaskResult.Failed;
            resultMessage = "Timeout reached while waiting for builds = " + timeout + " (minutes)";
            cancellingBuilds(buildsWaitList).then(function () {
                tl.setResult(resultState, resultMessage);
                clearInterval(timer);
                timer = null;
            });
        }
        else {
            var buildsWaitListIsEmpty = true;
            buildsWaitListIsEmpty = buildsWaitList.every(function () { return false; });
            if (resultState === tl.TaskResult.Failed || buildsWaitListIsEmpty) {
                cancellingBuilds(buildsWaitList).then(function () {
                    if (buildErrors) {
                        buildErrors.forEach(function (err) {
                            tl.error(err);
                        });
                    }
                    tl.setResult(resultState, resultMessage);
                    clearInterval(timer);
                    timer = null;
                });
            }
            else {
                Object.keys(buildsWaitList).forEach(function (build_id, index) {
                    return build_api.getBuild(build_id, teamProjectName).then(function (build) {
                        if (buildsWaitList[build_id] !== bi.BuildStatus[build.status]) {
                            var build_title_1 = "[" + build.definition.name + " / Build " + build.id + "]";
                            var build_result_1 = bi.BuildResult[build.result];
                            buildsWaitList[build_id] = bi.BuildStatus[build.status];
                            console.log("Build " + build_title_1 + " = " + buildsWaitList[build_id]);
                            if (build.status === bi.BuildStatus.Completed) {
                                if (build.result !== bi.BuildResult.Succeeded) {
                                    build_api.getBuildTimeline(teamProjectName, build.id).then(function (tasks) {
                                        if (build_result_1) {
                                            tasks.records.forEach(function (tsk) {
                                                if (tsk) {
                                                    if (((tsk.result === bi.TaskResult.Canceled) || (tsk.result === bi.TaskResult.Failed)) && (build.result !== bi.BuildResult.PartiallySucceeded)) {
                                                        buildErrors.push(build_title_1 + ": " + tsk.name + " = " + bi.TaskResult[tsk.result]);
                                                    }
                                                    else {
                                                        if (tsk.result === bi.TaskResult.SucceededWithIssues) {
                                                            tl.warning(build_title_1 + ": " + tsk.name + " = " + bi.TaskResult[tsk.result]);
                                                        }
                                                    }
                                                }
                                            });
                                            delete buildsWaitList[build_id];
                                            for (var k in buildsWaitList) {
                                                buildsWaitList[k] = bi.BuildStatus[bi.BuildStatus.All];
                                            }
                                            resultMessage = "=== The triggered build " + build_title_1 + " " + build_result_1 + "! ===";
                                            if (build.result === bi.BuildResult.PartiallySucceeded) {
                                                tl.warning(resultMessage);
                                            }
                                            else {
                                                resultState = tl.TaskResult.Failed;
                                            }
                                        }
                                    });
                                }
                                else {
                                    delete buildsWaitList[build_id];
                                    for (var k in buildsWaitList) {
                                        buildsWaitList[k] = bi.BuildStatus[bi.BuildStatus.All];
                                    }
                                    console.log("=== The build " + build_title_1 + " " + build_result_1 + " ===");
                                }
                            }
                            else {
                                console.log("Waiting...");
                            }
                        }
                        running = false;
                    }).catch(function (err) {
                        running = false;
                        console.log("Warning: " + err.message);
                    });
                });
            }
        }
    }, 5000);
}
function cancellingBuilds(buildsToCancel) {
    var deferred = Q.defer();
    var listIsEmpty = buildsToCancel.every(function () { return false; });
    if (cancellingOnError && (!listIsEmpty)) {
        console.log("An error occurred: Try to cancel builds...");
        var countOfCanceledBuilds_1 = 0;
        var countOfBuildsToCancel_1 = lengthOfArray(buildsToCancel);
        Object.keys(buildsToCancel).forEach(function (build_id) {
            if (buildsToCancel[build_id] !== bi.BuildStatus.Completed) {
                return build_api.getBuild(build_id, teamProjectName).then(function (build) {
                    var build_title = "[" + build.definition.name + " / Build " + build.id + "]";
                    console.log("Sending cancellation request to " + build_title + " ...");
                    build.status = bi.BuildStatus.Cancelling;
                    build.result = bi.BuildResult.Canceled;
                    return build_api.updateBuild(build, build.id, build.project.id).then(function (res) {
                        tl.warning("=== The triggered build " + build_title + " has been " + bi.BuildResult[res.result] + "! ===");
                        countOfCanceledBuilds_1 = countOfCanceledBuilds_1 + 1;
                        if (countOfCanceledBuilds_1 >= countOfBuildsToCancel_1) {
                            deferred.resolve(true);
                        }
                    });
                }).catch(function (err) {
                    tl.warning("The cancelling request failed: " + err.message);
                    deferred.resolve(null);
                });
            }
        });
    }
    else {
        deferred.resolve(null);
    }
    return deferred.promise;
}
var collectionUrl = tfsUri.substring(0, tfsUri.lastIndexOf("/"));
var base_uri = collectionUrl;
var http_proxy = tl.getInput('http_proxy');
var https_proxy = tl.getInput('https_proxy');
process.env.http_proxy = http_proxy;
process.env.https_proxy = https_proxy;
process.env.HTTP_PROXY = http_proxy;
process.env.HTTPS_PROXY = https_proxy;
var creds = getAuthentication();
var connection = new vm.WebApi(collectionUrl, creds);
var build_api = connection.getBuildApi();
waitForBuilds();
//# sourceMappingURL=waitForTriggeredBuilds.js.map