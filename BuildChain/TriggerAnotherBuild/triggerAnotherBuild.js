"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var tl = require("vsts-task-lib/task");
var vm = require("vso-node-api");
var bi = require("vso-node-api/interfaces/BuildInterfaces");
var Q = require("q");
var path = require("path");
var fs = require("fs");
var shell = require("shelljs");
var customAuth = tl.getBoolInput('customAuth', true);
var definitionName = tl.getInput('BuildDefinitionName', true);
var definitionIsInCurrentTeamProject = tl.getBoolInput('definitionIsInCurrentTeamProject', true);
var teamProjectUri = tl.getInput('teamProjectUri');
var triggerWithSourceVersion = tl.getBoolInput('triggerWithSourceVersion', true);
var triggerWithSourceBranch = tl.getBoolInput('triggerWithSourceBranch', true);
var customBranch = tl.getInput('customBranch');
var parameters = tl.getInput('parameters');
var demands = tl.getInput('demands');
var triggeredBuildId = tl.getInput('triggeredBuildId');
var multipleTriggers = tl.getBoolInput('multipleTriggers');
var multiParams = tl.getInput('multiParams');
var valuesRangeOnEachAgent = tl.getBoolInput('valuesRangeOnEachAgent');
var waitForTriggeredBuild = tl.getBoolInput('waitForTriggeredBuild', true);
var timeout = tl.getInput('timeout');
var registerToWait = tl.getBoolInput('registerToWait', true);
var waitTag = tl.getInput('waitTag');
var http_proxy = tl.getInput('http_proxy');
var https_proxy = tl.getInput('https_proxy');
var tfsUri = tl.getVariable('System.TeamFoundationCollectionUri');
var teamProjectName = tl.getVariable('System.TeamProject');
if (!definitionIsInCurrentTeamProject) {
    var teamProjectUriSlices = teamProjectUri.split('/');
    tfsUri = teamProjectUriSlices.slice(0, 4).join('/');
    teamProjectName = teamProjectUriSlices.slice(4, 5).join();
    if ((teamProjectUriSlices.length < 5) || (!tfsUri) || (!teamProjectName)) {
        tl.setResult(tl.TaskResult.Failed, "Error: Bad Team Project URL. Please make sure to provide valid team project URL including collection and team project, e.g: https://<ACCOUNTNAME>.visualstudio.com/DefaultCollection/<TEAMPROJECT>");
        process.exit(1);
    }
}
var version = tl.getVariable('Build.SourceVersion');
var shelveset = tl.getVariable('Build.SourceBranch');
var currentBuildDefinitionName = tl.getVariable('Build.DefinitionName');
var currentBuildID = tl.getVariable('Build.BuildId');
var currentBuildRepoType = tl.getVariable('Build.Repository.Provider');
var currentAgentID = parseInt(tl.getVariable('Agent.Id'));
var collectionUrl = tfsUri.substring(0, tfsUri.lastIndexOf("/"));
var base_uri = collectionUrl;
process.env.http_proxy = http_proxy;
process.env.https_proxy = https_proxy;
process.env.HTTP_PROXY = http_proxy;
process.env.HTTPS_PROXY = https_proxy;
var creds = getAuthentication();
var connection = new vm.WebApi(collectionUrl, creds);
var build_api = connection.getBuildApi();
var agent_api = connection.getTaskAgentApi(base_uri);
var triggerParam;
var agentName;
var buildsWaitList;
function errorHandler(e) {
    console.error("==== ERROR Occurred ====");
    console.error("Message: " + e.message);
    console.error("Stack: " + e.stack);
    var error = e.message;
    if (e.statusCode == 409) {
        error = "Failed to trigger the build [" + definitionName + "]: There's no available Agents in Pool to queue the build";
    }
    if (e.statusCode == 401) {
        error = "Failed to trigger the build [" + definitionName + "]: Bad credentials - Unauthorized (401)";
    }
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
function agentIncludesDemands(existsDemands, selectedDemands) {
    if (!selectedDemands) {
        return true;
    }
    if (selectedDemands && (!existsDemands)) {
        return false;
    }
    if (selectedDemands.length > existsDemands.length) {
        return false;
    }
    for (var attrname in selectedDemands) {
        if (selectedDemands[attrname] != existsDemands[attrname]) {
            return false;
        }
    }
    return true;
}
function triggerBuild() {
    console.log("Searching for definitions that named [%s]", definitionName);
    return build_api.getDefinitions(teamProjectName, definitionName).then(function (definitions) {
        if (definitions.length > 0) {
            console.log("%d Build found with the name [%s]", definitions.length, definitionName);
            return build_api.getDefinition(definitions[0].id, teamProjectName).then(function (definition) {
                var repoTypeIsOk = true;
                if ((triggerWithSourceVersion || triggerWithSourceBranch) && (definition.repository.type != currentBuildRepoType)) {
                    var err = "The build will NOT be triggered - Can't send Changeset or Shelveset to build with different type of repository";
                    tl.setResult(tl.TaskResult.Failed, err);
                    process.exit(1);
                }
                if ((triggerWithSourceVersion && !triggerWithSourceBranch) && (definition.repository.type != "TfsVersionControl")) {
                    console.log("The build repository type is " + definition.repository.type + " therefore it will be trigger with shelveset as well");
                    triggerWithSourceBranch = true;
                }
                var build = {
                    definition: definitions[0],
                    sourceVersion: (triggerWithSourceVersion && repoTypeIsOk) ? version : null,
                    sourceBranch: (triggerWithSourceBranch && repoTypeIsOk) ? shelveset : null
                };
                if (!triggerWithSourceBranch && customBranch && (customBranch != "")) {
                    if (customBranch.split("/").length < 2) {
                        var err = "Invalid Custom Source Branch. Please provide valid branch to the triggered build, e.g: refs/heads/master";
                        tl.setResult(tl.TaskResult.Failed, err);
                        process.exit(1);
                    }
                    build["sourceBranch"] = customBranch;
                    console.log("The build [" + build.definition.name + "] will be triggered with Source Branch: " + customBranch);
                }
                var demandsJSON = {};
                var demandsList = [];
                if (demands !== null) {
                    if (demands.endsWith(";")) {
                        demands = demands.substring(0, demands.length - 1);
                    }
                    demands.split(";").forEach(function (demand) {
                        if (demand.startsWith(" ")) {
                            demand = demand.substring(1);
                        }
                        if (demand.endsWith(" ")) {
                            demand = demand.substring(0, demand.length - 1);
                        }
                        var variable = demand.split("=");
                        demandsJSON[variable[0]] = variable[1];
                        demand = demand.replace("=", " -equals ");
                        demandsList.push(demand);
                    });
                }
                var currentBuildIDNum = parseInt(currentBuildID);
                return build_api.getBuild(currentBuildIDNum, teamProjectName).then(function (currentBuild) {
                    var current_build_title = currentBuild.definition.name + " / Build " + currentBuild.id;
                    var current_buildPageUrl = collectionUrl + "/" + teamProjectName + "/_build?_a=summary&buildId=" + currentBuild.id;
                    build["requestedBy"] = currentBuild.requestedBy;
                    build["requestedFor"] = currentBuild.requestedFor;
                    if (multipleTriggers && (multiParams != undefined)) {
                        if (multiParams == "") {
                            var err = "Invalid Multipliers Parameters. Make sure it's not empty and it's numerical range of values";
                            tl.setResult(tl.TaskResult.Failed, err);
                            process.exit(1);
                        }
                        console.log("Multiple Trigger...");
                        return MultipleBuilds(definition, build, parameters, demandsJSON, demandsList, current_build_title, current_buildPageUrl);
                    }
                    else {
                        console.log("Single Trigger...");
                        return queueSingleBuild(build, parameters, demandsList, current_build_title, current_buildPageUrl);
                    }
                });
            });
        }
        else {
            tl.setResult(tl.TaskResult.Failed, "No definitions named [" + definitionName + "] were found!");
        }
    });
}
function MultipleBuilds(buildDefinition, buildObj, parameters, demandsJSON, demandsList, current_build_title, current_buildPageUrl) {
    console.log("Multipliers params were provided therefore multiple builds will be triggered without waiting!");
    console.log("== If you want to wait then you will need to use the field -Register to wait- and the task -WaitForTriggeredBuilds- ==");
    waitForTriggeredBuild = false;
    if (multiParams.endsWith(";")) {
        multiParams = multiParams.substring(0, multiParams.length - 1);
    }
    multiParams.split(";").forEach(function (param) {
        if (param.startsWith(" ")) {
            param = param.substring(1);
        }
        if (param.endsWith(" ")) {
            param = param.substring(0, param.length - 1);
        }
        var parameter = param.split("=");
        var parameterName = parameter[0];
        var valRange = parameter[1].split("-");
        if ((parameter.length > 1) && (valRange.length > 1)) {
            if (valuesRangeOnEachAgent) {
                console.log("Trigger the values range on each Agent from the Pool...");
                console.log("Try to get Agents which meets the specified demands");
                if (buildDefinition.queue.pool) {
                    var triggeredBuildPoolID = buildDefinition.queue.pool.id;
                    tl.debug("triggeredBuildPoolID=" + triggeredBuildPoolID);
                    return agent_api.getAgents(triggeredBuildPoolID, null, true).then(function (agents) {
                        if (agents.length > 0) {
                            var noTriggers_1 = true;
                            var running_1 = false;
                            var i_1 = 0;
                            var timer_1 = setInterval(function () {
                                if (running_1)
                                    return;
                                if (i_1 < agents.length) {
                                    if ((agents[i_1].id == currentAgentID && registerToWait) || (!agents[i_1].enabled)) {
                                        if (!(agents[i_1].enabled)) {
                                            tl.warning("Build will not be triggered on agent [" + agents[i_1].name + "] which isn't enabled!");
                                        }
                                        else {
                                            tl.warning("Build which registered to the wait process couldn't be triggered on the same Agent that running the multi-params job!");
                                        }
                                        i_1 += 1;
                                    }
                                    else {
                                        running_1 = true;
                                        agentName = agents[i_1].name;
                                        tl.debug("------------------------------------------------------------------------------");
                                        tl.debug("Make sure the Agent [" + agentName + "] includes the specified demands:");
                                        tl.debug("agent.userCapabilities=" + JSON.stringify(agents[i_1].userCapabilities));
                                        tl.debug("demandsJSON=" + JSON.stringify(demandsJSON));
                                        if (agentIncludesDemands((agents[i_1].userCapabilities), demandsJSON)) {
                                            var triggerDemands = [];
                                            triggerDemands.push("Agent.Name -equals " + agentName);
                                            triggerDemands.concat(demandsList);
                                            tl.debug("triggerDemands:" + triggerDemands);
                                            tl.debug("------------------------------------------------------------------------------");
                                            queueMultiBuilds(buildObj, parameterName, valRange, triggerDemands, current_build_title, current_buildPageUrl).then(function () {
                                                i_1 += 1;
                                                noTriggers_1 = false;
                                                running_1 = false;
                                            }).catch(function (err) {
                                                errorHandler(err);
                                                clearInterval(timer_1);
                                                timer_1 = null;
                                            });
                                        }
                                        else {
                                            i_1 += 1;
                                            tl.debug("=> The Agent doesn't include the specified demands!");
                                            tl.debug("------------------------------------------------------------------------------");
                                            running_1 = false;
                                        }
                                    }
                                }
                                else {
                                    if (noTriggers_1) {
                                        tl.setResult(tl.TaskResult.Failed, "No Build has been triggered: No Agents were found with the specified demands!");
                                    }
                                    clearInterval(timer_1);
                                    timer_1 = null;
                                }
                            }, 2000);
                        }
                        else {
                            var err = "Failed to get Agents from Pool: ";
                            if (!customAuth) {
                                err += "Wrong permissions - [VSTS] Open the Agent Pools and grant [Project Collection Build Service] admin permissions";
                                tl.warning(err);
                            }
                            else {
                                err += "Make sure the selected Server Endpoint had permissions on the Agent Pool";
                                tl.warning(err);
                            }
                            tl.setResult(tl.TaskResult.Failed, err);
                        }
                    }).catch(function (err) {
                        errorHandler(err);
                    });
                }
                else {
                    var err = "Failed to get details about Agent Queues: ";
                    if (!customAuth) {
                        err = "Wrong permissions - [VSTS] Open the Agent Queues (at the team project) and grant [Project Collection Build Service] admin permissions";
                        tl.warning(err);
                    }
                    else {
                        err = "Make sure the selected Server Endpoint had permissions on the Agent Queue";
                        tl.warning(err);
                    }
                    tl.setResult(tl.TaskResult.Failed, err);
                }
            }
            else {
                queueMultiBuilds(buildObj, parameterName, valRange, demandsList, current_build_title, current_buildPageUrl).then(function (completed) {
                    return completed;
                });
            }
        }
        else {
            tl.setResult(tl.TaskResult.Failed, "Bad Multipliers Params, make sure the parameters are in the form of: param1=x-y;param2=w-z (x,y,w,z are numericals ranges from-to)");
        }
    });
}
function queueMultiBuilds(buildObj, parameter, range, buildDemands, current_build_title, current_buildPageUrl) {
    var deferred = Q.defer();
    var from = parseInt(range[0]);
    var to = parseInt(range[1]);
    var paramVal = from;
    var running = false;
    var timer = setInterval(function () {
        if (running)
            return;
        if (paramVal <= to) {
            running = true;
            triggerParam = parameter + "=" + paramVal;
            var triggerParams = triggerParam;
            if (parameters) {
                triggerParams += parameters;
            }
            tl.debug("triggerParams:" + triggerParams);
            queueSingleBuild(buildObj, triggerParams, buildDemands, current_build_title, current_buildPageUrl).then(function () {
                paramVal = paramVal + 1;
                running = false;
            }).catch(function (err) {
                errorHandler(err);
                clearInterval(timer);
                timer = null;
                deferred.reject(err);
            });
        }
        else {
            clearInterval(timer);
            timer = null;
            deferred.resolve(true);
        }
    }, 2000);
    return deferred.promise;
}
function queueSingleBuild(buildObj, buildParameters, buildDemands, current_build_title, current_buildPageUrl) {
    var parametersJSON = {};
    if (buildParameters !== null) {
        if (buildParameters.endsWith(";")) {
            buildParameters = buildParameters.substring(0, buildParameters.length - 1);
        }
        buildParameters.split(";").forEach(function (param) {
            if (param.startsWith(" ")) {
                param = param.substring(1);
            }
            if (param.endsWith(" ")) {
                param = param.substring(0, param.length - 1);
            }
            var variable = param.split("=");
            if (variable.length > 1) {
                parametersJSON[variable[0]] = variable[1];
            }
        });
        console.log("The build [" + buildObj.definition.name + "] will be triggered with the following parameters:");
    }
    var paramsList = JSON.stringify(parametersJSON);
    if (Object.keys(parametersJSON).length > 0) {
        console.log(paramsList);
        buildObj["parameters"] = paramsList;
    }
    if (buildDemands.length > 0) {
        console.log("The build [" + buildObj.definition.name + "] will be triggered on the following demands:");
        console.log(buildDemands);
        buildObj["demands"] = buildDemands;
    }
    return build_api.queueBuild(buildObj, buildObj.definition.project.id).then(function (newBuild) {
        if (!newBuild || newBuild === undefined) {
            tl.setResult(tl.TaskResult.Failed, "Failed to trigger the build [" + buildObj.definition.name + "]");
        }
        else {
            return createLinks(current_build_title, current_buildPageUrl, newBuild).then(function () {
                return waitAndFinish(newBuild);
            });
        }
    }).catch(errorHandler);
}
function createLinks(currentBuildTitle, currentBuildPageUrl, buildInfo) {
    var build_title = buildInfo.definition.name + " / Build " + buildInfo.id;
    if (agentName) {
        build_title += " - (Agent " + agentName + ")";
    }
    if (triggerParam) {
        build_title += " - (" + triggerParam + ")";
    }
    var buildPageUrl = collectionUrl + "/" + teamProjectName + "/_build?_a=summary&buildId=" + buildInfo.id;
    tl.debug('buildPageUrl: ' + buildPageUrl);
    var triggeredBuildLnkPath = process.env.BUILD_SOURCESDIRECTORY;
    var linkMarkdownFile = path.join(triggeredBuildLnkPath, 'triggered_builds_from' + currentBuildDefinitionName + "_" + currentBuildID + '.md');
    tl.debug('triggeredBuildLnkPath: ' + linkMarkdownFile);
    var summaryTitle = 'Triggered Builds Links';
    tl.debug('summaryTitle: ' + summaryTitle);
    var markdownContents = '[' + build_title + '](' + buildPageUrl + ')' + "<br />";
    fs.appendFile(linkMarkdownFile, markdownContents, function callBack(err) {
        if (err) {
            console.log("Error: Can't creating link to the triggered build: " + err);
        }
        else {
            console.log('##vso[task.addattachment type=Distributedtask.Core.Summary;name=' + summaryTitle + ';]' + linkMarkdownFile);
        }
    });
    return writeToBuildSummary(buildInfo.id, buildInfo.project.name, "Parent build", currentBuildTitle, currentBuildPageUrl);
}
function writeToBuildSummary(idOfBuild, projectName, sharedLinkTitle, sharedLinkName, sharedLinkPath) {
    var tempDir = shell.tempdir();
    var filename = path.join(tempDir, 'summary_links_for_' + idOfBuild + '.md');
    tl.debug('writeToBuildSummaryFile=' + filename);
    var markdownContents = '[' + sharedLinkName + '](' + sharedLinkPath + ')';
    fs.writeFileSync(filename, markdownContents);
    var deferred = Q.defer();
    fs.exists(filename, function (exists) {
        if (!exists) {
            tl.warning("Can't add build summary attachment to " + sharedLinkName + ": Failed to create links file");
            deferred.resolve(null);
        }
        return build_api.getBuild(idOfBuild, projectName).then(function (_build) {
            return build_api.getBuildTimeline(projectName, idOfBuild).then(function (_tasks) {
                if (_tasks.records.length < 0) {
                    deferred.resolve(null);
                    tl.warning("Can't add build summary attachment to " + sharedLinkName + ": Can't find any task record for the build");
                    return;
                }
                var projectId = _build.project.id;
                var buildId = _build.id;
                var type = "DistributedTask.Core.Summary";
                var name = sharedLinkTitle;
                var taskClient = connection.getTaskApi();
                fs.stat(filename, function (err, stats) {
                    if (err) {
                        deferred.resolve(null);
                        tl.warning(err.message);
                    }
                    else {
                        var headers = {};
                        headers["Content-Length"] = stats.size;
                        var stream = fs.createReadStream(filename);
                        taskClient.createAttachment(headers, stream, projectId, "build", _build.orchestrationPlan.planId, _tasks.id, _tasks.records[0].id, type, name).then(function () { return deferred.resolve(null); }, function (err) {
                            deferred.resolve(null);
                            console.log("Add the build user to [Project Collection Build Service Accounts] if it does not have write permissions for orchestration plan");
                            tl.warning("Can't add build summary attachment to " + sharedLinkName + ": " + err);
                        });
                    }
                });
            });
        });
    });
    return deferred.promise;
}
function waitAndFinish(buildInfo) {
    var build_title = "[" + buildInfo.definition.name + " / Build " + buildInfo.id + "]";
    var buildPageUrl = collectionUrl + "/" + teamProjectName + "/_build?_a=summary&buildId=" + buildInfo.id;
    console.log("------------------------------------------------------------------------------");
    console.log("- Triggered Build Info:");
    console.log("- URL:= " + buildPageUrl);
    console.log("- Build Definition Name:= " + buildInfo.definition.name);
    console.log("- Build ID:= " + buildInfo.id);
    console.log("------------------------------------------------------------------------------");
    var resultMessage = "";
    if (waitForTriggeredBuild) {
        console.log("Waiting for the triggered build: " + build_title);
        var startDate = new Date();
        var timeoutMinutesToAdd = parseInt(timeout) * 60000;
        var timeoutDate = new Date((new Date()).getTime() + timeoutMinutesToAdd);
        console.log("Triggered at: " + startDate);
        console.log("Timeout at: " + timeoutDate);
        console.log("Timeout = " + timeout + " (minutes)");
        var running_2 = false;
        var buildStatus_1 = bi.BuildStatus[bi.BuildStatus.All];
        var timer = setInterval(function () {
            if ((new Date()) > timeoutDate) {
                resultMessage = "Timeout reached = " + timeoutDate;
                tl.setResult(tl.TaskResult.Failed, resultMessage);
                clearInterval(timer);
                timer = null;
            }
            else {
                if (running_2)
                    return;
                running_2 = true;
                build_api.getBuild(buildInfo.id, buildInfo.definition.project.id).then(function (build) {
                    if (buildStatus_1 !== bi.BuildStatus[build.status]) {
                        buildStatus_1 = bi.BuildStatus[build.status];
                        console.log("Build " + build_title + " = " + buildStatus_1);
                        if (build.status === bi.BuildStatus.Completed || build.status === bi.BuildStatus.Cancelling) {
                            if (build.result !== bi.BuildResult.Succeeded) {
                                resultMessage = "The build " + build_title + " " + bi.BuildResult[build.result] + "!";
                                tl.setResult(tl.TaskResult.Failed, resultMessage);
                            }
                            else {
                                resultMessage = "The build " + build_title + " " + bi.BuildResult[build.result];
                                tl.setResult(tl.TaskResult.Succeeded, resultMessage);
                            }
                            clearInterval(timer);
                            timer = null;
                        }
                        else {
                            console.log("Waiting...");
                        }
                    }
                    running_2 = false;
                }).catch(function (err) {
                    errorHandler(err);
                    clearInterval(timer);
                    timer = null;
                });
            }
        }, 5000);
    }
    else {
        if (registerToWait) {
            var triggeredEnvVar = 'System.TriggerdBuilds_' + currentBuildID + '_' + waitTag;
            var buildsWaitListVar = tl.getVariable(triggeredEnvVar);
            if (buildsWaitListVar) {
                buildsWaitList = buildsWaitListVar + "," + buildInfo.id.toString();
            }
            else {
                if (buildsWaitList) {
                    buildsWaitList = buildsWaitList + "," + buildInfo.id.toString();
                }
                else {
                    buildsWaitList = buildInfo.id.toString();
                }
            }
            console.log('##vso[task.setvariable variable=' + triggeredEnvVar + ';]' + buildsWaitList);
        }
        if (triggeredBuildId && (triggeredBuildId != "")) {
            console.log('##vso[task.setvariable variable=' + triggeredBuildId + ';]' + (buildInfo.id));
        }
        resultMessage = "The build " + buildInfo.definition.name + " successfully queued: " + buildPageUrl;
        console.log(resultMessage);
    }
}
triggerBuild().catch(errorHandler);
//# sourceMappingURL=triggerAnotherBuild.js.map