# Build Chain Tasks #

This is an extension which includes tasks that help you or your team to chain builds within VSTS.
It make use of VSTS API to queue build definitions and wait for them (within the same Team Project or even across projects)
This extension provides the following features:
- Trigger build definitions across team projects with specific variables and on specific Agent according to capabilities (demands).
- Trigger the builds with Changeset\Shelveset.
- Wait for the triggered build or wait for group of builds according to custom tag.
- Bind builds in groups and wait for specific build chain according to tag .
- Fail and cancel the triggered builds upon failure of master.
- Display the errors of the child builds in the main build which includes the trigger task
- Link triggered builds to triggering build (link on parent and child side)

## Supported Versions ##

The build tasks are supported for both VSTS and TFS on-Premises from Version 2015 Update 2 updwards.

## Release Notes ##

The tasks are written in Node.js and thus supports Windows and Linux as well.


## Trigger Another Build ##

1. Add the task to your build.
2. Provide the **definition name** of the build you would like to trigger.
3. If the build to trigger exists in the same team project then leave the checkbox **Same Team Project (as this build)** checked, otherwise uncheck and provide full URL of the team project which hold the build to be triggered.
4. Keep the checkbox **Custom Authentication** unchecked to use the system bearer token authorization or you can checked it and provide username and password via service endpoint.
5. Expand the **Advanced** section for advanced settings:
	- **Wait for completion:** If you enable this option, the build task will wait for the completion of the triggered build, the task checks the triggered build and continue only if it finished, therefore if you don't have an additional available build agent you will get stuck, as the original build is waiting for the completion of the other build, which can only be started once the original build is finished. Also make sure to set timeout for the wait.
	- **Trigger With Changeset:** If this option is enabled, the triggered build will use the same source version as the build that includes the task, which means if the build was triggered for a specific changeset or label, the same source version will used in the triggered build. This option is disabled by default and the triggered build run on latest sources.
	- **Trigger With Shelveset:** If this is enabled, the triggered build will use the same source branch as the build that includes the task. This means if the build is triggered for the source branch refs/heads/master, the triggered build will as well. if this option is enabled then you need to make sure that the triggered build can actually be triggered for that branch.
	- **Register to wait:** Once this checked the triggered build will be added into wait list (this list will be used by the step "Wait For Triggered Builds"). **This feature allows you to create group of builds which is list of triggered builds **
	- **Wait Tag:** Specify a custom tag which is label for the list of the triggered builds to be used by the wait step "Wait For Triggered Builds", the tags binding the triggered builds into groups and the step "Wait For Triggered Builds" can wait for a specif group of builds.
	- **Parameters:** A comma-delimited list of parameters in the form of param1=value1;param2=value2;... this parameters will be sent to the triggered build as variables. Those variables can be used on the child build which triggered and the parameters values can be build variable, for example if you defined on the current build variable called release_version and you want to trigger child build with this parameter then you can pass it on this field " release_version=$(release_version)" and reuse it on the child build.
	- **Demands:** A comma-delimited list of demands in the form of capability1=value1;capability2=value2;... for example: git=2.12;cmake:3.9.2. Depending on your build definition demands that are required from the agent. When queuing a build additional demands can be specified, for example to filter for a special build agent.
6. Expand the "System Settings" if the Agent is behind a proxy, this needed if you don't had environment variables on the host and you are behind a proxy then the task will need to know about the proxy settings.


## Wait For Triggered Builds ##

1. Add the task to your build.
2. Provide the **Wait Tags** which is a comma-delimited list of tags for example: default,chain1,chain2. If you triggered some builds using the parent task and you used the option **Register to wait** then here you can select the wait lists or the triggered builds groups (according to the custom tag) for the wait process. 
3. **Wait for builds which are in the same team project (as this build)**, otherwise uncheck and provide full URL of the team project which holds the triggered builds.
4. Keep the checkbox **Custom Authentication** unchecked to use the system bearer token authorization or you can checked it and provide username and password via service endpoint.
5. Specify the **Timeout [minutes]** for the wait process, an empty or zero value indicates an infinite timeout.
6. **Cancel Build-Chain On Failure:** Set this to true for canceling the build-chain if error occurred on any child build (build-chain or wait-list is list of triggered builds which registered for the wait process by custom tag).
7. Expand the "System Settings" if the Agent is behind a proxy, this needed if you don't had environment variables on the host and you are behind a proxy then the task will need to know about the proxy settings.


## Best Practice ##

Trigger your builds with the task **"Trigger Another Build"**, 
Create group of triggered builds by register them to the wait process with custom tag and wait for them using **"Wait For Triggered Builds"** :

![BestPractice](Snapshots/BestPractice.PNG)

**Register to wait:**

![Register_to_wait](Snapshots/Register_to_wait.png)

**Wait Options:**
* You can choose to cancel the build chain if any error occurred on the child builds (the triggered builds which are within the same tag)
* Specify the timeout, if it reached then it fail the step. An empty or zero value indicates an infinite timeout.

![WaitOptions](Snapshots/WaitOptions.png)

