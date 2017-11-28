/// <reference path="./node_modules/@types/node/index.d.ts"/>

import tl = require('vsts-task-lib/task');
import * as vm from 'vso-node-api';
import * as ba from 'vso-node-api/BuildApi';
import * as bi from 'vso-node-api/interfaces/BuildInterfaces';
import * as tac from 'vso-node-api/TaskAgentApiBase';
import * as tai from 'vso-node-api/interfaces/TaskAgentInterfaces';
import Q = require('q');
import path = require('path');
import fs = require('fs');
import shell = require('shelljs');

//========================================================================================================================
// get inputs
var customAuth = tl.getBoolInput('customAuth', true);
var definitionName = tl.getInput('BuildDefinitionName', true);
//var definitionId = tl.getInput('BuildDefinitionID');
var definitionIsInCurrentTeamProject = tl.getBoolInput('definitionIsInCurrentTeamProject', true);
var teamProjectUri = tl.getInput('teamProjectUri');
var triggerWithSourceVersion = tl.getBoolInput('triggerWithSourceVersion', true);
var triggerWithSourceBranch = tl.getBoolInput('triggerWithSourceBranch', true);
var customBranch = tl.getInput('customBranch');
var parameters: any = tl.getInput('parameters');
var demands: any = tl.getInput('demands');
var triggeredBuildId = tl.getInput('triggeredBuildId');
var multipleTriggers = tl.getBoolInput('multipleTriggers');
var multiParams: any = tl.getInput('multiParams');
var valuesRangeOnEachAgent: any = tl.getBoolInput('valuesRangeOnEachAgent');
var waitForTriggeredBuild = tl.getBoolInput('waitForTriggeredBuild', true);
var timeout = tl.getInput('timeout');
var registerToWait = tl.getBoolInput('registerToWait', true);
var waitTag = tl.getInput('waitTag');
var http_proxy = tl.getInput('http_proxy');
var https_proxy = tl.getInput('https_proxy');
//========================================================================================================================
// get build variables (of the running build) 
var tfsUri = tl.getVariable('System.TeamFoundationCollectionUri'); // or = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
var currentTeamProjectName = tl.getVariable('System.TeamProject');
var triggeredTeamProjectName = currentTeamProjectName;
if (!definitionIsInCurrentTeamProject) {
    var teamProjectUriSlices = teamProjectUri.split('/');
    tfsUri = teamProjectUriSlices.slice(0, 4).join('/')
    triggeredTeamProjectName = teamProjectUriSlices.slice(4, 5).join();
    if ((teamProjectUriSlices.length < 5) || (!tfsUri) || (!triggeredTeamProjectName)) {
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
//========================================================================================================================
// set connection variables
let collectionUrl: string = tfsUri.substring(0, tfsUri.lastIndexOf("/"));
var base_uri = collectionUrl;
process.env.http_proxy = http_proxy;
process.env.https_proxy = https_proxy;
process.env.HTTP_PROXY = http_proxy;
process.env.HTTPS_PROXY = https_proxy;
let creds = getAuthentication();
var connection = new vm.WebApi(collectionUrl, creds);
//let build_api: ba.BuildApi = connection.getBuildApi();
var build_api: ba.IBuildApi = connection.getBuildApi();
var agent_api: tac.ITaskAgentApiBase = connection.getTaskAgentApi(base_uri);
//========================================================================================================================
// set global variables
var triggerParam;
var agentName;
var buildsWaitList;

//=========== Functions ==================================================================================================
function errorHandler(e: any) {
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

function getAuthentication(): any {
    //Permissions:
    //Project Collection Administrators
    //Project Collection Build Administrators
    //Project Collection Build Service Accounts
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
    // try to get the build definition
    return build_api.getDefinitions(triggeredTeamProjectName, definitionName).then(function (definitions: bi.BuildDefinition[]) {
        if (definitions.length > 0) {
            console.log("%d Build found with the name [%s]", definitions.length, definitionName);
            //let definition: bi.BuildDefinition = definitions[0];
            return build_api.getDefinition(definitions[0].id, triggeredTeamProjectName).then(function (definition: bi.BuildDefinition) {
                let repoTypeIsOk = true;
                if ((triggerWithSourceVersion || triggerWithSourceBranch) && (definition.repository.type != currentBuildRepoType)) {
                    let err = "The build will NOT be triggered - Can't send Changeset or Shelveset to build with different type of repository";
                    tl.setResult(tl.TaskResult.Failed, err);
                    process.exit(1);
                }
                if ((triggerWithSourceVersion && !triggerWithSourceBranch) && (definition.repository.type != "TfsVersionControl")) {
                    console.log("The build repository type is " + definition.repository.type + " therefore it will be trigger with shelveset as well");
                    triggerWithSourceBranch = true;
                }
                let build = {
                    definition: definitions[0],
                    //priority: priority ? priority : 3 // need to check how it works for example bi.QueuePriority.AboveNormal from input
                    sourceVersion: (triggerWithSourceVersion && repoTypeIsOk) ? version : null,
                    sourceBranch: (triggerWithSourceBranch && repoTypeIsOk) ? shelveset : null
                    //parameters: paramsList,
                    //demands: demandsList
                };
                // set custom Source Branch to the trigger
                if (!triggerWithSourceBranch && customBranch && (customBranch != "")) {
                    if (customBranch.split("/").length < 2) {
                        let err = "Invalid Custom Source Branch. Please provide valid branch to the triggered build, e.g: refs/heads/master";
                        //tl.warning(err);
                        tl.setResult(tl.TaskResult.Failed, err);
                        process.exit(1);
                    }
                    build["sourceBranch"] = customBranch;
                    console.log("The build [" + build.definition.name + "] will be triggered with Source Branch: " + customBranch);
                }
                // create object of the selected demands for the triggered build
                let demandsJSON = {};
                let demandsList: string[] = [];
                if (demands !== null) {
                    if (demands.endsWith(";")) { demands = demands.substring(0, demands.length - 1); }
                    demands.split(";").forEach(function (demand: any) {
                        if (demand.startsWith(" ")) { demand = demand.substring(1); }
                        if (demand.endsWith(" ")) { demand = demand.substring(0, demand.length - 1); }
                        let variable = demand.split("=");
                        demandsJSON[variable[0]] = variable[1];
                        demand = demand.replace("=", " -equals ");
                        demandsList.push(demand);
                    });
                }
                // try to trigger the build
                let currentBuildIDNum = parseInt(currentBuildID);
                return build_api.getBuild(currentBuildIDNum, currentTeamProjectName).then(function (currentBuild: bi.Build) {
                    let current_build_title = currentBuild.definition.name + " / Build " + currentBuild.id;
                    let teamProjectNameUri = encodeURIComponent(currentTeamProjectName.trim());
                    let current_buildPageUrl = collectionUrl + "/" + teamProjectNameUri + "/_build?_a=summary&buildId=" + currentBuild.id;
                    build["requestedBy"] = currentBuild.requestedBy;
                    build["requestedFor"] = currentBuild.requestedFor;
                    if (multipleTriggers && (multiParams != undefined)) {
                        if (multiParams == "") {
                            let err = "Invalid Multipliers Parameters. Make sure it's not empty and it's numerical range of values";
                            tl.setResult(tl.TaskResult.Failed, err);
                            process.exit(1);
                        }
                        console.log("Multiple Trigger...");
                        return MultipleBuilds(definition, build, parameters, demandsJSON, demandsList, current_build_title, current_buildPageUrl).then((completed) => {
                            tl.setResult(tl.TaskResult.Succeeded, "The Multiple Trigger Completed");
                        }).catch(function (err: any) {
                            errorHandler(err);
                        });
                    }
                    else { // Single Trigger
                        console.log("Single Trigger...");
                        return queueSingleBuild(build, parameters, demandsList, current_build_title, current_buildPageUrl)
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
    var deferred = Q.defer();
    // create object of multi parameters
    console.log("Multipliers params were provided therefore multiple builds will be triggered without waiting!");
    console.log("== If you want to wait then you will need to use the field -Register to wait- and the task -WaitForTriggeredBuilds- ==");
    waitForTriggeredBuild = false;
    if (multiParams.endsWith(";")) { multiParams = multiParams.substring(0, multiParams.length - 1); }
    multiParams.split(";").forEach(function (param: any) {
        if (param.startsWith(" ")) { param = param.substring(1); }
        if (param.endsWith(" ")) { param = param.substring(0, param.length - 1); }
        let parameter = param.split("=");
        let parameterName = parameter[0];
        let valRange;
        if (parameter.length > 1) {
            valRange = parameter[1].split("-");
        }
        if ((!valRange) || valRange.length < 1) {
            deferred.reject("Bad Multipliers Params, make sure the parameters are in the form of: param=x-y (x,y are numericals range from-to)");
        }
        if (valuesRangeOnEachAgent) {
            console.log("Trigger the values range on each Agent from the Pool...");
            console.log("Try to get Agents which meets the specified demands");
            if (buildDefinition.queue.pool) {
                let triggeredBuildPoolID = buildDefinition.queue.pool.id;
                tl.debug("triggeredBuildPoolID=" + triggeredBuildPoolID);
                return agent_api.getAgents(triggeredBuildPoolID, null, true).then((agents: tai.TaskAgent[]) => {
                    if (agents.length > 0) {
                        let noTriggers = true;
                        let running = false;
                        let i = 0;
                        let timer = setInterval(() => {
                            if (running) return;
                            if (i < agents.length) {
                                if ((agents[i].id == currentAgentID && registerToWait) || (!agents[i].enabled)) {
                                    if (!(agents[i].enabled)) {
                                        tl.warning("Build will not be triggered on agent [" + agents[i].name + "] which isn't enabled!");
                                    } else {
                                        tl.warning("Build which registered to the wait process couldn't be triggered on the same Agent that running the multi-params job!");
                                    }
                                    i += 1;
                                }
                                else {
                                    running = true;
                                    agentName = agents[i].name;
                                    // make sure that agent includes the specified demands
                                    tl.debug("------------------------------------------------------------------------------");
                                    tl.debug("Make sure the Agent [" + agentName + "] includes the specified demands:");
                                    tl.debug("agent.userCapabilities=" + JSON.stringify(agents[i].userCapabilities));
                                    tl.debug("demandsJSON=" + JSON.stringify(demandsJSON));
                                    if (agentIncludesDemands((agents[i].userCapabilities), demandsJSON)) {
                                        let triggerDemands: string[] = [];
                                        triggerDemands.push("Agent.Name -equals " + agentName);
                                        triggerDemands.concat(demandsList);
                                        tl.debug("triggerDemands:" + triggerDemands);
                                        tl.debug("------------------------------------------------------------------------------");
                                        queueMultiBuilds(buildObj, parameterName, valRange, triggerDemands, current_build_title, current_buildPageUrl).then(() => {
                                            i += 1;
                                            noTriggers = false;
                                            running = false;
                                        }).catch(function (err: any) {
                                            clearInterval(timer);
                                            timer = null;
                                            deferred.reject(err);
                                        });
                                    }
                                    else {
                                        i += 1;
                                        tl.debug("=> The Agent doesn't include the specified demands!");
                                        tl.debug("------------------------------------------------------------------------------");
                                        running = false;
                                    }
                                }
                            }
                            else {
                                clearInterval(timer);
                                timer = null;
                                if (noTriggers) {
                                    let err = "No Build has been triggered: No Agents were found with the specified demands!";
                                    deferred.reject(err);
                                }
                                else {
                                    deferred.resolve(true);
                                }
                            }
                        }, 2000);
                    }
                    else {
                        let err = "Failed to get Agents from Pool: "
                        if (!customAuth) {
                            err += "Wrong permissions - [VSTS] Open the Agent Pools and grant [Project Collection Build Service] admin permissions";
                            tl.warning(err);
                        }
                        else {
                            err += "Make sure the selected Server Endpoint had permissions on the Agent Pool"
                            tl.warning(err);
                        }
                        deferred.reject(err);
                    }
                }).catch(function (err: any) {
                    deferred.reject(err);
                });
            }
            else {
                let err = "Failed to get details about Agent Queues: ";
                if (!customAuth) {
                    err = "Wrong permissions - [VSTS] Open the Agent Queues (at the team project) and grant [Project Collection Build Service] admin permissions";
                    tl.warning(err);
                }
                else {
                    err = "Make sure the selected Server Endpoint had permissions on the Agent Queue"
                    tl.warning(err);
                }
                deferred.reject(err);
            }
        }
        else {
            queueMultiBuilds(buildObj, parameterName, valRange, demandsList, current_build_title, current_buildPageUrl).then((completed) => {
                deferred.resolve(completed);
            }).catch(function (err: any) {
                deferred.reject(err);
            });
        }
    });
    return deferred.promise;
}

function queueMultiBuilds(buildObj, parameter, range, buildDemands, current_build_title, current_buildPageUrl) {
    var deferred = Q.defer();
    let from = parseInt(range[0]);
    let to = parseInt(range[1]);
    if (isNaN(from) || isNaN(to)) {
        deferred.reject("Bad Multipliers Params: Make sure the multipliers parameters are numericals (e.g: param1=1-10;param2=3-4)");
    }
    let paramVal = from;
    let running = false;
    //for (let paramVal = from; paramVal <= to; paramVal += 1) {
    let timer = setInterval(() => {
        if (running) return;
        if (paramVal <= to) {
            running = true;
            triggerParam = parameter + "=" + paramVal;
            let triggerParams = triggerParam;
            if (parameters) { triggerParams += parameters; }
            tl.debug("triggerParams:" + triggerParams);
            queueSingleBuild(buildObj, triggerParams, buildDemands, current_build_title, current_buildPageUrl).then(() => {
                paramVal = paramVal + 1;
                running = false;
            }).catch(function (err: any) {
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
    // create object of the selected parameters for the triggered build
    let parametersJSON = {};
    if (buildParameters !== null) {
        //if (parameters.endsWith(",") || parameters.endsWith(";")) { parameters = parameters.substring(0, parameters.length - 1); }
        //var separator = /[','|';']/;
        if (buildParameters.endsWith(";")) { buildParameters = buildParameters.substring(0, buildParameters.length - 1); }
        buildParameters.split(";").forEach(function (param: any) {
            if (param.startsWith(" ")) { param = param.substring(1); }
            if (param.endsWith(" ")) { param = param.substring(0, param.length - 1); }
            var variable = param.split("=");
            if (variable.length > 1) { parametersJSON[variable[0]] = variable[1]; }
        });
        console.log("The build [" + buildObj.definition.name + "] will be triggered with the following parameters:");
    }
    let paramsList = JSON.stringify(parametersJSON);
    if (Object.keys(parametersJSON).length > 0) {
        console.log(paramsList);
        buildObj["parameters"] = paramsList;
    }
    if (buildDemands.length > 0) {
        console.log("The build [" + buildObj.definition.name + "] will be triggered on the following demands:");
        console.log(buildDemands);
        buildObj["demands"] = buildDemands;
    }
    return build_api.queueBuild(buildObj, buildObj.definition.project.id).then(function (newBuild: any) {
        if (!newBuild || newBuild === undefined) {
            tl.setResult(tl.TaskResult.Failed, "Failed to trigger the build [" + buildObj.definition.name + "]");
        }
        else {
            return createLinks(current_build_title, current_buildPageUrl, newBuild).then(() => {
                return waitAndFinish(newBuild);
            });
        }
    }).catch(errorHandler);
}

function createLinks(currentBuildTitle: string, currentBuildPageUrl: string, buildInfo: bi.Build) {
    // add hyperlink of triggered build (child build) into the current build summary 
    var build_title = buildInfo.definition.name + " / Build " + buildInfo.id;
    if (agentName) { build_title += " - (Agent " + agentName + ")"; }
    if (triggerParam) { build_title += " - (" + triggerParam + ")"; }
    let teamProjectNameUri = encodeURIComponent(triggeredTeamProjectName.trim());
    var buildPageUrl = collectionUrl + "/" + teamProjectNameUri + "/_build?_a=summary&buildId=" + buildInfo.id;
    tl.debug('buildPageUrl: ' + buildPageUrl);
    var triggeredBuildLnkPath = process.env.BUILD_SOURCESDIRECTORY;
    //var linkMarkdownFile = path.join(triggeredBuildLnkPath, 'triggered_build_' + buildInfo.definition.name + '_' + buildInfo.id + '.md');
    var linkMarkdownFile = path.join(triggeredBuildLnkPath, 'triggered_builds_from' + currentBuildDefinitionName + "_" + currentBuildID + '.md');
    tl.debug('triggeredBuildLnkPath: ' + linkMarkdownFile);
    var summaryTitle = 'Triggered Builds Links';
    tl.debug('summaryTitle: ' + summaryTitle);
    var markdownContents = '[' + build_title + '](' + buildPageUrl + ')' + "<br />";
    fs.appendFile(linkMarkdownFile, markdownContents, function callBack(err: any) {
        if (err) {
            // don't fail the build -- there just won't be a link
            console.log("Error: Can't creating link to the triggered build: " + err);
        } else {
            console.log('##vso[task.addattachment type=Distributedtask.Core.Summary;name=' + summaryTitle + ';]' + linkMarkdownFile);
        }
    });
    // add hyperlink of current build (parent build) into the triggered build summary 
    return writeToBuildSummary(buildInfo.id, buildInfo.project.name, "Parent build", currentBuildTitle, currentBuildPageUrl);
}

function writeToBuildSummary(idOfBuild: any, projectName: string, sharedLinkTitle: string, sharedLinkName: string, sharedLinkPath: string) {
    var tempDir = shell.tempdir();
    var filename = path.join(tempDir, 'summary_links_for_' + idOfBuild + '.md');
    tl.debug('writeToBuildSummaryFile=' + filename);
    var markdownContents = '[' + sharedLinkName + '](' + sharedLinkPath + ')';
    fs.writeFileSync(filename, markdownContents);
    var deferred = Q.defer();
    fs.exists(filename, (exists: boolean) => {
        if (!exists) {
            tl.warning("Can't add build summary attachment to " + sharedLinkName + ": Failed to create links file");
            deferred.resolve(null);
        }
        return build_api.getBuild(idOfBuild, projectName).then(function (_build: any) {
            return build_api.getBuildTimeline(projectName, idOfBuild).then(function (_tasks: any) {
                // need at least one record to create summary attachment
                if (_tasks.records.length < 0) {
                    deferred.resolve(null);
                    tl.warning("Can't add build summary attachment to " + sharedLinkName + ": Can't find any task record for the build");
                    return;
                }
                var projectId: string = _build.project.id;
                var buildId: number = _build.id;
                var type = "DistributedTask.Core.Summary";
                var name = sharedLinkTitle;
                var taskClient: any = connection.getTaskApi();
                //Add user to Project Collection Build Service Accounts -> if does not have write permissions for orchestration plan 
                fs.stat(filename, (err: NodeJS.ErrnoException, stats: fs.Stats) => {
                    if (err) {
                        //reject only if want to catch the error
                        //deferred.reject(err);
                        deferred.resolve(null);
                        tl.warning(err.message);
                    }
                    else {
                        var headers = {};
                        headers["Content-Length"] = stats.size;
                        var stream = fs.createReadStream(filename);
                        taskClient.createAttachment(
                            headers,
                            stream,
                            projectId,
                            "build",
                            _build.orchestrationPlan.planId,
                            _tasks.id,
                            _tasks.records[0].id,
                            type,
                            name).then(() => deferred.resolve(null), (err: any) => {
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

function waitAndFinish(buildInfo: bi.Build) {
    var build_title = "[" + buildInfo.definition.name + " / Build " + buildInfo.id + "]";
    var buildPageUrl = collectionUrl + "/" + triggeredTeamProjectName + "/_build?_a=summary&buildId=" + buildInfo.id;
    console.log("------------------------------------------------------------------------------");
    console.log("- Triggered Build Info:");
    console.log("- URL:= " + buildPageUrl);
    console.log("- Build Definition Name:= " + buildInfo.definition.name);
    console.log("- Build ID:= " + buildInfo.id);
    console.log("------------------------------------------------------------------------------");
    let resultMessage = "";
    if (waitForTriggeredBuild) {
        console.log("Waiting for the triggered build: " + build_title);
        var startDate = new Date();
        var timeoutMinutesToAdd = parseInt(timeout) * 60000;
        var timeoutDate = new Date((new Date()).getTime() + timeoutMinutesToAdd);
        console.log("Triggered at: " + startDate);
        console.log("Timeout at: " + timeoutDate);
        console.log("Timeout = " + timeout + " (minutes)");
        let running = false;
        let buildStatus = bi.BuildStatus[bi.BuildStatus.All];
        var timer = setInterval(function () {
            if ((new Date()) > timeoutDate) {
                resultMessage = "Timeout reached = " + timeoutDate;
                tl.setResult(tl.TaskResult.Failed, resultMessage);
                clearInterval(timer);
                timer = null;
            }
            else {
                // make sure one request sent each time
                if (running) return;
                running = true;
                // check the status of the queued build
                build_api.getBuild(buildInfo.id, buildInfo.definition.project.id).then(function (build: any) {
                    if (buildStatus !== bi.BuildStatus[build.status]) {
                        buildStatus = bi.BuildStatus[build.status];
                        console.log("Build " + build_title + " = " + buildStatus);
                        if (build.status === bi.BuildStatus.Completed || build.status === bi.BuildStatus.Cancelling) {
                            if (build.result !== bi.BuildResult.Succeeded) {
                                resultMessage = "The build " + build_title + " " + bi.BuildResult[build.result] + "!";
                                //console.error(resultMessage);
                                tl.setResult(tl.TaskResult.Failed, resultMessage);
                            }
                            else {
                                resultMessage = "The build " + build_title + " " + bi.BuildResult[build.result];
                                //console.log(resultMessage);
                                tl.setResult(tl.TaskResult.Succeeded, resultMessage);
                            }
                            clearInterval(timer);
                            timer = null;
                        }
                        else { console.log("Waiting..."); }
                    }
                    // mark the request job for rest api as finished	
                    running = false;
                }).catch(function (err: any) {
                    errorHandler(err);
                    clearInterval(timer);
                    timer = null;
                });
            }
        }, 5000);
    }
    else {
        if (registerToWait) {
            // keep the build id of the triggered build on environment variable (append it if the var already exists unless create new one)
            let triggeredEnvVar = 'System.TriggerdBuilds_' + currentBuildID + '_' + waitTag;
            let buildsWaitListVar = tl.getVariable(triggeredEnvVar);
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
        //tl.setResult(tl.TaskResult.Succeeded, resultMessage);
    }
}
//========================================================================================================================

triggerBuild().catch(errorHandler);
