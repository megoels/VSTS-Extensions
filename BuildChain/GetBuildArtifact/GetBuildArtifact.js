"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
//import { Artifact } from 'vso-node-api/interfaces/ReleaseInterfaces';
const tl = require("vsts-task-lib/task");
const vm = require("vso-node-api");
const Q = require("q");
const bi = require("vso-node-api/interfaces/BuildInterfaces");
//=========== Get Inputs =================================================================================================
var buildDefName = tl.getInput('buildDefName');
//var buildDefID = tl.getInput('buildDefID');
var artifactPathVarName = tl.getInput('artifactPathVarName');
var buildArtifactName = tl.getInput('buildArtifactName');
var latestSucceeded = tl.getBoolInput('latestSucceeded');
var http_proxy = tl.getInput('http_proxy');
var https_proxy = tl.getInput('https_proxy');
//=========== Get Build Variables ========================================================================================
var tfsUri = tl.getVariable('System.TeamFoundationCollectionUri'); // or = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
var projectName = tl.getVariable('System.TeamProject');
var agentID = tl.getVariable('Agent.Id');
var buildID = tl.getVariable('Build.BuildId');
var projectID = tl.getVariable('System.TeamProjectId');
var definitionID = tl.getVariable('System.DefinitionId');
//=========== Functions ==================================================================================================
function errorHandler(e) {
    //var error = JSON.parse(JSON.stringify(e));
    console.error("==== ERROR Occurred ====");
    console.error("Message: " + e.message);
    console.error("Stack: " + e.stack);
    tl.setResult(tl.TaskResult.Failed, e.message);
}
function getAuthentication() {
    let serverEndpoint = tl.getPathInput('connectedServiceName');
    /*
    if (customAuth && serverEndpoint) {
        tl.debug("A custom connected service endpoint was provided");
        let auth = tl.getEndpointAuthorization(serverEndpoint, false);
        let username = auth.parameters['username'];
        let password = auth.parameters['password'];
        //let token = auth.parameters["AccessToken"];
        return vm.getBasicHandler(username, password);
    } else {
        tl.debug("Connected Service NOT Found, try to get system OAuth Token");
    */
    let token = null;
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
        let err = "Could not find System.AccessToken. Please enable the token in the build Options page (tick the box 'Allow Scripts to Access OAuth Token').";
        tl.setResult(tl.TaskResult.Failed, err);
        process.exit(1);
    }
    return vm.getBearerHandler(token);
    //}
}
//async function getArtifactPath(projectName, buildDefName, latestSucceeded, buildArtifactName) {
function getArtifactPath(projectName, buildDefName, latestSucceeded, buildArtifactName) {
    var deferred = Q.defer();
    console.log('================== Getting Artifact path ==================');
    let definition = [];
    //let definitions = await build_api.getDefinitions(projectName, buildDefName);
    var timer = setTimeout(function () {
        return build_api.getDefinitions(projectName, buildDefName).then((definitions) => {
            if (definitions.length > 0) {
                definition.push(+definitions[0].id);
                console.log('Build definition id: ' + definitions[0].id);
                let filter = null;
                if (latestSucceeded) {
                    console.log('Getting Artifact of last succesfull build');
                    filter = bi.BuildResult.Succeeded;
                }
                //let lastbuild = await build_api.getBuilds(projectName, definition, null, null, null, null, null, null, null, filter, null, null, 1);
                return build_api.getBuilds(projectName, definition, null, null, null, null, null, null, null, filter, null, null, 1).then((lastbuild) => {
                    if (lastbuild.length > 0) {
                        let lastbuildId = lastbuild[0].id;
                        console.log('Build run id: ' + lastbuildId);
                        if (buildArtifactName) {
                            //lastbuildArtifact = await build_api.getArtifact(lastbuildId, buildArtifactName, projectName);
                            return build_api.getArtifact(lastbuildId, buildArtifactName, projectName).then((lastbuildArtifact) => {
                                deferred.resolve(lastbuildArtifact);
                            });
                        }
                        else {
                            //let lastbuildArtifacts = await build_api.getArtifacts(lastbuildId, projectName);
                            return build_api.getArtifacts(lastbuildId, projectName).then((lastbuildArtifacts) => {
                                deferred.resolve(lastbuildArtifacts);
                            });
                        }
                    }
                    else {
                        tl.error("No build results found for the definition " + buildDefName);
                        deferred.resolve(false);
                    }
                });
            }
            else {
                tl.error("No definition found which named " + buildDefName);
                deferred.resolve(false);
            }
        }).catch(function (err) {
            errorHandler(err);
            deferred.resolve(false);
            //deferred.reject(err);
        });
    }, 1000);
    return deferred.promise;
}
//=========== Execution ==================================================================================================
// set connection variables
process.env.http_proxy = http_proxy;
process.env.https_proxy = https_proxy;
process.env.HTTP_PROXY = http_proxy;
process.env.HTTPS_PROXY = https_proxy;
let collectionUrl = tfsUri.substring(0, tfsUri.lastIndexOf("/"));
let creds = getAuthentication();
let connection = new vm.WebApi(collectionUrl, creds);
var build_api = connection.getBuildApi();
// try to get build artifact
getArtifactPath(projectName, buildDefName, latestSucceeded, buildArtifactName).then((lastbuildArtifact) => {
    if ((!lastbuildArtifact) || lastbuildArtifact == undefined || (lastbuildArtifact && lastbuildArtifact == '')) {
        tl.setResult(tl.TaskResult.Failed, 'No build artifact found!');
    }
    else {
        let folderName = '';
        if (lastbuildArtifact.length && lastbuildArtifact[0]) {
            folderName = lastbuildArtifact[0].name;
            lastbuildArtifact = lastbuildArtifact[0].resource.downloadUrl;
        }
        else {
            folderName = lastbuildArtifact.name;
            lastbuildArtifact = (lastbuildArtifact.resource.downloadUrl);
        }
        if (lastbuildArtifact.indexOf('visualstudio.com') == -1) {
            lastbuildArtifact = lastbuildArtifact + '/' + folderName;
            lastbuildArtifact = lastbuildArtifact.split('file:')[lastbuildArtifact.split('file:').length - 1];
        }
        console.log('Build variable name: ' + artifactPathVarName);
        console.log('Artifact Url: ' + lastbuildArtifact);
        console.log('##vso[task.setvariable variable=' + artifactPathVarName + ';]' + lastbuildArtifact);
    }
}).catch(errorHandler);
//# sourceMappingURL=GetBuildArtifact.js.map