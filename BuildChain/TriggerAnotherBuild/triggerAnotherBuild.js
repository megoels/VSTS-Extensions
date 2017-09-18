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
var parameters = tl.getInput('parameters');
var demands = tl.getInput('demands');
var triggerWithChangeset = tl.getBoolInput('triggerWithChangeset', true);
var triggerWithShelveset = tl.getBoolInput('triggerWithShelveset', true);
var waitForTriggeredBuild = tl.getBoolInput('waitForTriggeredBuild', true);
var timeout = tl.getInput('timeout');
var registerToWait = tl.getBoolInput('registerToWait', true);
var waitTag = tl.getInput('waitTag');
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
var currentBuildID = tl.getVariable('Build.BuildId');
var currentBuildRepoType = tl.getVariable('Build.Repository.Provider');
function errorHandler(e) {
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
function triggerBuild() {
    console.log("Searching for definitions with the name: " + definitionName);
    return build_api.getDefinitions(teamProjectName, definitionName).then(function (definitions) {
        if (definitions.length > 0) {
            console.log("Build found with name " + definitionName);
            return build_api.getDefinition(definitions[0].id, teamProjectName).then(function (def) {
                var repoTypeIsOk = true;
                if ((triggerWithChangeset || triggerWithShelveset) && (def.repository.type != currentBuildRepoType)) {
                    var err = "The build will NOT be triggered - Can't send Changeset or Shelveset to build with different type of repository";
                    tl.setResult(tl.TaskResult.Failed, err);
                    process.exit(1);
                }
                if ((triggerWithChangeset && !triggerWithShelveset) && (def.repository.type != "TfsVersionControl")) {
                    console.log("The build repository type is " + def.repository.type + " therefore it will be trigger with shelveset as well");
                    triggerWithShelveset = true;
                }
                var build = {
                    definition: definitions[0],
                    sourceVersion: (triggerWithChangeset && repoTypeIsOk) ? version : null,
                    sourceBranch: (triggerWithShelveset && repoTypeIsOk) ? shelveset : null
                };
                var parametersJSON = {};
                if (parameters !== null) {
                    if (parameters.endsWith(";")) {
                        parameters = parameters.substring(0, parameters.length - 1);
                    }
                    parameters.split(";").forEach(function (param) {
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
                    console.log("the build will be triggered with the following parameters:");
                }
                var paramsList = JSON.stringify(parametersJSON);
                if (Object.keys(parametersJSON).length > 0) {
                    console.log(paramsList);
                    build["parameters"] = paramsList;
                }
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
                        demand = demand.replace("=", " -equals ");
                        demandsList.push(demand);
                    });
                    console.log("the build will be triggered with the following demands:");
                }
                if (demandsList.length > 0) {
                    console.log(demandsList);
                    build["demands"] = demandsList;
                }
                return build_api.getBuild(currentBuildID, teamProjectName).then(function (currentBuild) {
                    var current_build_title = currentBuild.definition.name + " / Build " + currentBuild.id;
                    var current_buildPageUrl = collectionUrl + "/" + teamProjectName + "/_build?_a=summary&buildId=" + currentBuild.id;
                    build["requestedBy"] = currentBuild.requestedBy;
                    build["requestedFor"] = currentBuild.requestedFor;
                    return build_api.queueBuild(build, build.definition.project.id).then(function (newBuild) {
                        createLinks(current_build_title, current_buildPageUrl, newBuild).then(function () {
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
function createLinks(currentBuildTitle, currentBuildPageUrl, buildInfo) {
    var build_title = buildInfo.definition.name + " / Build " + buildInfo.id;
    var buildPageUrl = collectionUrl + "/" + teamProjectName + "/_build?_a=summary&buildId=" + buildInfo.id;
    tl.debug('buildPageUrl: ' + buildPageUrl);
    var triggeredBuildLnkPath = process.env.BUILD_SOURCESDIRECTORY;
    var linkMarkdownFile = path.join(triggeredBuildLnkPath, 'triggered_build_' + buildInfo.definition.name + '_' + buildInfo.id + '.md');
    tl.debug('triggeredBuildLnkPath: ' + linkMarkdownFile);
    var summaryTitle = 'Triggered Builds Links';
    tl.debug('summaryTitle: ' + summaryTitle);
    var markdownContents = '[' + build_title + '](' + buildPageUrl + ')';
    fs.writeFile(linkMarkdownFile, markdownContents, function callBack(err) {
        if (err) {
            console.log('Error creating link to the triggered build: ' + err);
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
            console.log("Can't add build summary attachment to " + sharedLinkName + ": Failed to create links file");
            deferred.resolve(null);
        }
        return build_api.getBuild(idOfBuild, projectName).then(function (_build) {
            return build_api.getBuildTimeline(projectName, idOfBuild).then(function (_tasks) {
                if (_tasks.records.length < 0) {
                    deferred.resolve(null);
                    console.log("Can't add build summary attachment to " + sharedLinkName + ": Can't find any task record for the build");
                    return;
                }
                var projectId = _build.project.id;
                var buildId = _build.id;
                var type = "DistributedTask.Core.Summary";
                var name = sharedLinkTitle;
                var taskClient = connection.getTaskApi();
                fs.stat(filename, function (err, stats) {
                    if (err) {
                        deferred.reject(err);
                        console.log(err);
                    }
                    else {
                        var headers = {};
                        headers["Content-Length"] = stats.size;
                        var stream = fs.createReadStream(filename);
                        taskClient.createAttachment(headers, stream, projectId, "build", _build.orchestrationPlan.planId, _tasks.id, _tasks.records[0].id, type, name).then(function () { return deferred.resolve(null); }, function (err) {
                            deferred.reject(err);
                            console.log("Can't add build summary attachment to " + sharedLinkName + ": " + err);
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
        var running_1 = false;
        var buildStatus_1 = bi.BuildStatus[bi.BuildStatus.All];
        var timer = setInterval(function () {
            if ((new Date()) > timeoutDate) {
                resultMessage = "Timeout reached = " + timeoutDate;
                tl.setResult(tl.TaskResult.Failed, resultMessage);
                clearInterval(timer);
                timer = null;
            }
            else {
                if (running_1)
                    return;
                running_1 = true;
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
                    running_1 = false;
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
            var buildsWaitList = tl.getVariable(triggeredEnvVar);
            if (buildsWaitList) {
                buildsWaitList = buildsWaitList + "," + buildInfo.id.toString();
            }
            else {
                buildsWaitList = buildInfo.id.toString();
            }
            console.log('##vso[task.setvariable variable=' + triggeredEnvVar + ';]' + buildsWaitList);
        }
        resultMessage = "The build " + buildInfo.definition.name + " successfully queued and passed: " + buildPageUrl;
        tl.setResult(tl.TaskResult.Succeeded, resultMessage);
    }
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
triggerBuild().catch(errorHandler);
//# sourceMappingURL=triggerAnotherBuild.js.map