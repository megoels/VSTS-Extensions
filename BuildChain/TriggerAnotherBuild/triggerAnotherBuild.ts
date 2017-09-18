/// <reference path="./node_modules/@types/node/index.d.ts"/>

import tl = require('vsts-task-lib/task');
import * as vm from 'vso-node-api';
import * as ba from 'vso-node-api/BuildApi';
import * as bi from 'vso-node-api/interfaces/BuildInterfaces';
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
var parameters: any = tl.getInput('parameters');
var demands: any = tl.getInput('demands');
var triggerWithChangeset = tl.getBoolInput('triggerWithChangeset', true);
var triggerWithShelveset = tl.getBoolInput('triggerWithShelveset', true);
var waitForTriggeredBuild = tl.getBoolInput('waitForTriggeredBuild', true);
var timeout = tl.getInput('timeout');
var registerToWait = tl.getBoolInput('registerToWait', true);
var waitTag = tl.getInput('waitTag');

//========================================================================================================================
// get build variables (of the running build) 
var tfsUri = tl.getVariable('System.TeamFoundationCollectionUri'); // or = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
var teamProjectName = tl.getVariable('System.TeamProject');
if (!definitionIsInCurrentTeamProject) {
    var teamProjectUriSlices = teamProjectUri.split('/');
    tfsUri = teamProjectUriSlices.slice(0, 4).join('/')
    teamProjectName = teamProjectUriSlices.slice(4, 5).join();
    if ((teamProjectUriSlices.length < 5) || (!tfsUri) || (!teamProjectName)) {
        tl.setResult(tl.TaskResult.Failed, "Error: Bad Team Project URL. Please make sure to provide valid team project URL including collection and team project, e.g: https://<ACCOUNTNAME>.visualstudio.com/DefaultCollection/<TEAMPROJECT>");
        process.exit(1);
    }
}
var version = tl.getVariable('Build.SourceVersion');
var shelveset = tl.getVariable('Build.SourceBranch');
var currentBuildID = tl.getVariable('Build.BuildId');
var currentBuildRepoType = tl.getVariable('Build.Repository.Provider');

//=========== Functions ==================================================================================================
function errorHandler(e: any) {
    //var error = JSON.parse(JSON.stringify(e));
    //if(e.statusCode == 409)	{
    //	error = "Failed to find agent with demands"
    //}
    console.error("==== ERROR Occurred ====");
    console.error("Message: " + e.message);
    console.error("Stack: " + e.stack);
    var error = e.message;
    if (e.statusCode == 409) {
        error = "Failed to trigger the build [" + definitionName + "]: No agent on the pool could be found to queue the build";
    }
    if (e.statusCode == 401) {
        error = "Failed to trigger the build [" + definitionName + "]: Bad credentials - Unauthorized (401)";
    }
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


function triggerBuild() {
    console.log("Searching for definitions with the name: " + definitionName);
    // try to get the build definition
    return build_api.getDefinitions(teamProjectName, definitionName).then(function (definitions: any) {
        if (definitions.length > 0) {
            console.log("Build found with name " + definitionName);
            //let definition: bi.BuildDefinition = definitions[0];
            return build_api.getDefinition(definitions[0].id, teamProjectName).then(function (def: any) {
                let repoTypeIsOk = true;
                if ((triggerWithChangeset || triggerWithShelveset) && (def.repository.type != currentBuildRepoType)) {
                    let err = "The build will NOT be triggered - Can't send Changeset or Shelveset to build with different type of repository";
                    tl.setResult(tl.TaskResult.Failed, err);
                    process.exit(1);
                }
                if ((triggerWithChangeset && !triggerWithShelveset) && (def.repository.type != "TfsVersionControl")) {
                    console.log("The build repository type is " + def.repository.type + " therefore it will be trigger with shelveset as well");
                    triggerWithShelveset = true;
                }
                let build = {
                    definition: definitions[0],
                    //priority: priority ? priority : 3, check how to use the enum bi.QueuePriority.AboveNormal and etc.
                    sourceVersion: (triggerWithChangeset && repoTypeIsOk) ? version : null,
                    sourceBranch: (triggerWithShelveset && repoTypeIsOk) ? shelveset : null
                    //parameters: paramsList,
                    //demands: demandsList
                };
                // create object of build parameters
                let parametersJSON = {};
                if (parameters !== null) {
                    //if (parameters.endsWith(",") || parameters.endsWith(";")) { parameters = parameters.substring(0, parameters.length - 1); }
                    //var separator = /[','|';']/;
                    if (parameters.endsWith(";")) { parameters = parameters.substring(0, parameters.length - 1); }
                    parameters.split(";").forEach(function (param: any) {
                        if (param.startsWith(" ")) { param = param.substring(1); }
                        if (param.endsWith(" ")) { param = param.substring(0, param.length - 1); }
                        var variable = param.split("=");
                        if (variable.length > 1) { parametersJSON[variable[0]] = variable[1]; }
                    });
                    console.log("the build will be triggered with the following parameters:");
                }
                let paramsList = JSON.stringify(parametersJSON);
                if (Object.keys(parametersJSON).length > 0) {
                    console.log(paramsList);
                    build["parameters"] = paramsList;
                }
                // create object of build demands
                let demandsList: string[] = [];
                if (demands !== null) {
                    if (demands.endsWith(";")) { demands = demands.substring(0, demands.length - 1); }
                    demands.split(";").forEach(function (demand: any) {
                        if (demand.startsWith(" ")) { demand = demand.substring(1); }
                        if (demand.endsWith(" ")) { demand = demand.substring(0, demand.length - 1); }
                        demand = demand.replace("=", " -equals ");
                        demandsList.push(demand);
                    });
                    console.log("the build will be triggered with the following demands:");
                }
                if (demandsList.length > 0) {
                    console.log(demandsList);
                    build["demands"] = demandsList;
                }

                // try to trigger the build
                return build_api.getBuild(currentBuildID, teamProjectName).then(function (currentBuild: bi.Build) {
                    let current_build_title = currentBuild.definition.name + " / Build " + currentBuild.id;
                    let current_buildPageUrl = collectionUrl + "/" + teamProjectName + "/_build?_a=summary&buildId=" + currentBuild.id;
                    build["requestedBy"] = currentBuild.requestedBy;
                    build["requestedFor"] = currentBuild.requestedFor;
                    return build_api.queueBuild(build, build.definition.project.id).then(function (newBuild: any) {
                        //if (newBuild && newBuild.id){}
                        createLinks(current_build_title, current_buildPageUrl, newBuild).then(() => {
                            waitAndFinish(newBuild);
                        });
                    });
                });

            });
        }
        else {
            tl.setResult(tl.TaskResult.Failed, "No definition found which named " + definitionName);
        }
    });
}

function createLinks(currentBuildTitle: string, currentBuildPageUrl: string, buildInfo: bi.Build) {
    // add hyperlink of triggered build (child build) into the current build summary 
    var build_title = buildInfo.definition.name + " / Build " + buildInfo.id;
    var buildPageUrl = collectionUrl + "/" + teamProjectName + "/_build?_a=summary&buildId=" + buildInfo.id;
    tl.debug('buildPageUrl: ' + buildPageUrl);
    var triggeredBuildLnkPath = process.env.BUILD_SOURCESDIRECTORY;
    var linkMarkdownFile = path.join(triggeredBuildLnkPath, 'triggered_build_' + buildInfo.definition.name + '_' + buildInfo.id + '.md');
    tl.debug('triggeredBuildLnkPath: ' + linkMarkdownFile);
    var summaryTitle = 'Triggered Builds Links';
    tl.debug('summaryTitle: ' + summaryTitle);
    var markdownContents = '[' + build_title + '](' + buildPageUrl + ')';
    fs.writeFile(linkMarkdownFile, markdownContents, function callBack(err: any) {
        if (err) {
            //don't fail the build -- there just won't be a link
            console.log('Error creating link to the triggered build: ' + err);
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
            console.log("Can't add build summary attachment to " + sharedLinkName + ": Failed to create links file");
            deferred.resolve(null);
        }
        return build_api.getBuild(idOfBuild, projectName).then(function (_build: any) {
            return build_api.getBuildTimeline(projectName, idOfBuild).then(function (_tasks: any) {
                // need at least one record to create summary attachment
                if (_tasks.records.length < 0) {
                    deferred.resolve(null);
                    console.log("Can't add build summary attachment to " + sharedLinkName + ": Can't find any task record for the build");
                    return;
                }
                var projectId: string = _build.project.id;
                var buildId: number = _build.id;
                var type = "DistributedTask.Core.Summary";
                var name = sharedLinkTitle;
                var taskClient: any = connection.getTaskApi();
                fs.stat(filename, (err: NodeJS.ErrnoException, stats: fs.Stats) => {
                    if (err) {
                        deferred.reject(err);
                        console.log(err);
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
                                deferred.reject(err)
                                console.log("Can't add build summary attachment to " + sharedLinkName + ": " + err);
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
    var buildPageUrl = collectionUrl + "/" + teamProjectName + "/_build?_a=summary&buildId=" + buildInfo.id;
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
            let buildsWaitList = tl.getVariable(triggeredEnvVar);
            if (buildsWaitList) {
                buildsWaitList = buildsWaitList + "," + buildInfo.id.toString();
            }
            else {
                buildsWaitList = buildInfo.id.toString();
            }
            console.log('##vso[task.setvariable variable=' + triggeredEnvVar + ';]' + buildsWaitList);

            // create json of triggered build info
            //var triggeredJSON = {};
            //triggeredJSON["TriggerdBuild.DefinitionName"] = buildInfo.definition.name;
            //triggeredJSON["TriggerdBuild.Id"] = buildInfo.id;
            //triggeredJSON["TriggerdBuild.Tag"] = waitTag;
            //let jsonPath = "triggered_builds_from_build_$currentBuildID.ini"
            //write the triggered build info into file
            //fs.writeFile(jsonPath, triggeredJSON, function callBack(err: any) {
            //	if (err) {
            //		//don't fail the build -- there just won't be a link
            //		console.log('Error creating [' + jsonPath + ']: ' + err);
            //	}
            //});
        }
        resultMessage = "The build " + buildInfo.definition.name + " successfully queued and passed: " + buildPageUrl;
        //console.log(resultMessage);
        tl.setResult(tl.TaskResult.Succeeded, resultMessage);
    }
}

//========================================================================================================================
// set connection variables
let collectionUrl: string = tfsUri.substring(0, tfsUri.lastIndexOf("/"));
var base_uri = collectionUrl;

var http_proxy = tl.getInput('http_proxy');
var https_proxy = tl.getInput('https_proxy');
process.env.http_proxy = http_proxy;
process.env.https_proxy = https_proxy;
process.env.HTTP_PROXY = http_proxy;
process.env.HTTPS_PROXY = https_proxy;

let creds = getAuthentication();
var connection = new vm.WebApi(collectionUrl, creds);
//let build_api: ba.BuildApi = connection.getBuildApi();
var build_api: any = connection.getBuildApi();
//========================================================================================================================

triggerBuild().catch(errorHandler);
