var retryBuildMenu = (function () {
        "use strict";
        return {
            execute: function (actionContext) {
                VSS.require(["require", "exports", "TFS/Build/RestClient", "VSS/Service"], function (require, exports, RestClient, Service) {
                    var vsoContext = VSS.getWebContext();
                    var buildClient = Service.getCollectionClient(RestClient.BuildHttpClient);
                    VSS.ready(function () {
                        // get the build
                        buildClient.getBuild(actionContext.id, vsoContext.project.name).then(function (build) {
                        // and queue it again
                        buildClient.queueBuild(build, build.definition.project.id).then(function (newBuild) {
                            // and navigate to the build summary page
                                var buildPageUrl = vsoContext.host.uri + "/" + vsoContext.project.name + "/_build?_a=summary&buildId=" + newBuild.id;
                                window.parent.location.href = buildPageUrl;
                                //window.location.href = buildPageUrl
                            });
                        });
                    });
                });
            }
        };
    }());
VSS.register("retryBuildMenu", function (context) {
    return retryBuildMenu;
});
