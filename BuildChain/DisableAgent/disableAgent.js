"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var tl = require("vsts-task-lib/task");
var vm = require("vso-node-api/WebApi");
var bi = require("vso-node-api/interfaces/BuildInterfaces");
var customAuth = tl.getBoolInput('customAuth', true);
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
function disableAgent() {
    var running = false;
    var buildTimeline = false;
    var timer = setInterval(function () {
        if (running)
            return;
        running = true;
        return buildapi.getBuildTimeline(teamProjectName, buildID).then(function (tasks) {
            var buildFailed = false;
            buildFailed = tasks.records.some(function (task) {
                if (task.result === bi.TaskResult.Failed || task.result === bi.TaskResult.SucceededWithIssues) {
                    tl.debug("The build step [" + task.name + "] = " + bi.TaskResult[task.result]);
                    return true;
                }
                buildTimeline = true;
            }, this);
            if (buildFailed) {
                console.log("The build failed then Agent will be disabled");
                return buildapi.getBuild(buildID, projectID).then(function (build) {
                    if (build.queue.pool) {
                        tl.debug("Build Pool:=" + build.queue.pool.name);
                        var intAgentID_1 = parseInt(agentID);
                        tl.debug("build.queue.pool.id=" + build.queue.pool.id);
                        tl.debug("intAgentID=" + intAgentID_1);
                        return agentapi.getAgent(build.queue.pool.id, intAgentID_1, true, true, null).then(function (agent) {
                            if (agent) {
                                tl.debug("Build Agent:=" + agent.name);
                                agent.enabled = false;
                                console.log("Disabling the Agent " + agent.name + "...");
                                return agentapi.updateAgent(agent, build.queue.pool.id, intAgentID_1).then(function (agent) {
                                    console.log("Agent [" + agent.name + "] was successfully disabled");
                                    tl.setResult(tl.TaskResult.Succeeded, "Agent [" + agent.name + "] was successfully disabled");
                                    clearInterval(timer);
                                    timer = null;
                                }).catch(function (err) {
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
                            tl.warning("Wrong permissions: [VSTS] Open the Agent Queues (at the team project) and grant [Project Collection Build Service] admin permissions");
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
        }).catch(function (err) {
            errorHandler(err);
            clearInterval(timer);
            timer = null;
        });
    }, 2000);
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
disableAgent();
//# sourceMappingURL=disableAgent.js.map