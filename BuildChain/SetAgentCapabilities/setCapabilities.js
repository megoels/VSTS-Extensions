"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var tl = require("vsts-task-lib/task");
var vm = require("vso-node-api/WebApi");
var bi = require("vso-node-api/interfaces/BuildInterfaces");
var Promise = require("promise");
var customAuth = tl.getBoolInput('customAuth', true);
var capabilities = tl.getInput('capabilities');
var capabilityByBuildStatus = tl.getBoolInput('capabilityByBuildStatus');
var capabilitiesOnFailure = tl.getInput('capabilitiesOnFailure');
var capabilitiesOnSuccess = tl.getInput('capabilitiesOnSuccess');
var http_proxy = tl.getInput('http_proxy');
var https_proxy = tl.getInput('https_proxy');
var tfsUri = tl.getVariable('System.TeamFoundationCollectionUri');
var teamProjectName = tl.getVariable('System.TeamProject');
var agentID = tl.getVariable('Agent.Id');
var buildID = tl.getVariable('Build.BuildId');
var projectID = tl.getVariable('System.TeamProjectId');
var definitionID = tl.getVariable('System.DefinitionId');
function errorHandler(e) {
    console.error("==== ERROR Occurred ====");
    console.error("Message: " + e.message);
    console.error("Stack: " + e.stack);
    tl.setResult(tl.TaskResult.Failed, e.message);
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
function mergeObjectsOptions(srcObject, extraObject) {
    var target = {};
    for (var attrname in srcObject) {
        target[attrname] = srcObject[attrname];
    }
    for (var attrname in extraObject) {
        target[attrname] = extraObject[attrname];
    }
    return target;
}
function setCapabilities(userCapabilities) {
    var userCapabilitiesObj = {};
    if (userCapabilities && (userCapabilities.indexOf("=") >= 0)) {
        userCapabilities.split(";").forEach(function (capability) {
            if (capability.startsWith(" ")) {
                capability = capability.substring(1);
            }
            if (capability.endsWith(" ")) {
                capability = capability.substring(0, capability.length - 1);
            }
            var capObj = capability.split("=");
            if (capObj.length > 1) {
                userCapabilitiesObj[capObj[0]] = capObj[1];
            }
        });
        var intBuildID = parseInt(buildID);
        return buildapi.getBuild(intBuildID, teamProjectName).then(function (build) {
            if (build.queue.pool) {
                tl.debug("Build Pool:= " + build.queue.pool.name);
                var intAgentID_1 = parseInt(agentID);
                tl.debug("build.queue.pool.id=" + build.queue.pool.id);
                tl.debug("intAgentID=" + intAgentID_1);
                return agentapi.getAgent(build.queue.pool.id, intAgentID_1, true, true, null).then(function (agent) {
                    if (agent) {
                        tl.debug("agent.userCapabilities=" + JSON.stringify(agent.userCapabilities));
                        userCapabilitiesObj = mergeObjectsOptions((agent.userCapabilities), userCapabilitiesObj);
                        return agentapi.updateAgentUserCapabilities(userCapabilitiesObj, build.queue.pool.id, intAgentID_1).then(function () {
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
                    tl.warning("Wrong permissions: [VSTS] Open the Agent Queues (at the team project) and grant [Project Collection Build Service] admin permissions");
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
    var running = false;
    return new Promise(function (resolve) {
        var interval = setInterval(function () {
            if (running)
                return;
            running = true;
            var intBuildID = parseInt(buildID);
            return buildapi.getBuildTimeline(teamProjectName, intBuildID).then(function (tasks) {
                var buildFailed = false;
                buildFailed = tasks.records.some(function (task) {
                    if (task.result === bi.TaskResult.Failed || task.result === bi.TaskResult.SucceededWithIssues) {
                        console.log("The build step [" + task.name + "] = " + bi.TaskResult[task.result]);
                        return true;
                    }
                });
                if (buildFailed) {
                    console.log("The build failed!");
                    resolve(true);
                    clearInterval(interval);
                    interval = null;
                }
                else {
                    running = false;
                    if (tasks.records.length <= 1)
                        return;
                    console.log("There's no failures on any build step");
                    resolve(false);
                    clearInterval(interval);
                    interval = null;
                }
            }).catch(function (err) {
                resolve(true);
                errorHandler(err);
                clearInterval(interval);
                interval = null;
            });
        }, 2000);
    });
}
process.env.http_proxy = http_proxy;
process.env.https_proxy = https_proxy;
process.env.HTTP_PROXY = http_proxy;
process.env.HTTPS_PROXY = https_proxy;
var collectionUrl = tfsUri.substring(0, tfsUri.lastIndexOf("/"));
var base_uri = collectionUrl;
if (tfsUri.indexOf("visualstudio.com") < 0) {
    base_uri = collectionUrl.substring(0, collectionUrl.lastIndexOf("/"));
}
var creds = getAuthentication();
var connection = new vm.WebApi(collectionUrl, creds);
var buildapi = connection.getBuildApi();
var agentapi = connection.getTaskAgentApi(base_uri);
if (capabilityByBuildStatus) {
    checkIfBuildFailed().then(function (failed) {
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
//# sourceMappingURL=setCapabilities.js.map