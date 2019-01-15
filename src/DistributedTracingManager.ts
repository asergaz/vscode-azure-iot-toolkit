// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as iothub from "azure-iothub";
import * as uuid from "uuid";
import * as vscode from "vscode";
import { BaseExplorer } from "./baseExplorer";
import { Constants, DistributedSettingUpdateType } from "./constants";
import { SamplingModeItem } from "./Model/SamplingModeItem";
import { DistributedTracingLabelNode } from "./Nodes/DistributedTracingLabelNode";
import { DistributedTracingSettingNode } from "./Nodes/DistributedTracingSettingNode";
import { TelemetryClient } from "./telemetryClient";
import { Utility } from "./utility";

export class DistributedTracingManager extends BaseExplorer {
    constructor(outputChannel: vscode.OutputChannel) {
        super(outputChannel);
    }

    public async updateDistributedTracingSetting(node, updateType: DistributedSettingUpdateType) {
        let iotHubConnectionString = await Utility.getConnectionString(Constants.IotHubConnectionStringKey, Constants.IotHubConnectionStringTitle);
        if (!iotHubConnectionString) {
            return;
        }

        TelemetryClient.sendEvent(Constants.IoTHubAIUpdateDistributedSettingStartEvent);

        let deviceIds: string[] = [];
        if (!node) {
            let selectedDeviceId: string[] = await vscode.window.showQuickPick(
                Utility.getNoneEdgeDeviceIdList(iotHubConnectionString),
                { placeHolder: "Select devices...", ignoreFocusOut: true, canPickMany: true },
            );

            if (selectedDeviceId !== undefined && selectedDeviceId.length > 0) {
                deviceIds = selectedDeviceId;
            }
        } else {
            deviceIds = [node.deviceNode.deviceId];
        }

        if (deviceIds.length === 0) {
            return;
        }

        this._outputChannel.show();
        await this.updateDistributedTracingSettingForDevices(deviceIds, iotHubConnectionString, updateType);

        if (node instanceof DistributedTracingLabelNode) {
            vscode.commands.executeCommand("azure-iot-toolkit.refresh", node);
        } else if (node instanceof DistributedTracingSettingNode) {
            vscode.commands.executeCommand("azure-iot-toolkit.refresh", node.parent);
        } else {
            vscode.commands.executeCommand("azure-iot-toolkit.refresh");
        }
    }

    public async updateDistributedTracingSettingForDevices(deviceIds: string[], iotHubConnectionString: string, updateType: DistributedSettingUpdateType) {
        let registry = iothub.Registry.fromConnectionString(iotHubConnectionString);

        let mode: boolean = undefined;
        let samplingRate: number = undefined;
        let twin;

        if (deviceIds.length === 1) {
            await vscode.window.withProgress({
                title: `Get Current Distributed Tracing Setting`,
                location: vscode.ProgressLocation.Notification,
            }, async () => {
                twin = await Utility.getTwin(registry, deviceIds[0]);

                if (twin.properties.desired[Constants.DISTRIBUTED_TWIN_NAME]) {
                    mode = Utility.parseDesiredSamplingMode(twin);
                    samplingRate = Utility.parseDesiredSamplingRate(twin);
                }

                if (updateType === DistributedSettingUpdateType.OnlySamplingRate) {
                    mode = undefined;
                }

                if (updateType === DistributedSettingUpdateType.OnlyMode) {
                    samplingRate = undefined;
                }
            });
        }

        if (updateType !== DistributedSettingUpdateType.OnlySamplingRate) {
            let selectedItem: SamplingModeItem = await vscode.window.showQuickPick(
                this.getSamplingModePickupItems(),
                { placeHolder: "Select whether to enable/disable the distributed tracing...", ignoreFocusOut: true },
            );
            if (!selectedItem) {
                return;
            }
            mode = selectedItem.distributedTracingEnabled;
        }

        if (updateType !== DistributedSettingUpdateType.OnlyMode) {
            if (mode !== false) {
                samplingRate = await this.promptForSamplingRate(`Enter sampling rate, integer within [0, 100]`, samplingRate);

                if (samplingRate === undefined) {
                    return;
                }
            }
        }

        await vscode.window.withProgress({
            title: `Update Distributed Tracing Setting`,
            location: vscode.ProgressLocation.Notification,
        }, async () => {
            try {
                const result = await this.updateDeviceTwin(mode, samplingRate, iotHubConnectionString, deviceIds);
                TelemetryClient.sendEvent(Constants.IoTHubAIUpdateDistributedSettingDoneEvent,
                    { Result: "Success", UpdateType: updateType.toString(), DeviceCound: deviceIds.length.toString(),
                    SamplingRate: samplingRate ? samplingRate.toString() : "" , SamplingMode: mode ? mode.toString() : "" }, iotHubConnectionString);

                this.outputLine(Constants.IoTHubDistributedTracingSettingLabel,
                    `Update distributed tracing setting for device [${deviceIds.join(",")}] complete!` + result);
            } catch (err) {
                TelemetryClient.sendEvent(Constants.IoTHubAIUpdateDistributedSettingDoneEvent,
                    { Result: "Fail", UpdateType: updateType.toString(), DeviceCound: deviceIds.length.toString(),
                    SamplingRate: samplingRate ? "" : samplingRate.toString(), SamplingMode: mode ? "" : mode.toString() }, iotHubConnectionString);
                this.outputLine(Constants.IoTHubDistributedTracingSettingLabel, `Failed to get or update distributed setting: ${err.message}`);
                return;
            }
        });
    }

    private async updateDeviceTwin(enable: boolean, samplingRate: number, iotHubConnectionString: string, deviceIds: string[]) {
        let twinPatch = {
            etag: "*",
            properties: {
                desired: {},
            },
        };

        if (enable === undefined && samplingRate === undefined) {
            return;
        }

        if (!twinPatch.properties.desired[Constants.DISTRIBUTED_TWIN_NAME]) {
            twinPatch.properties.desired[Constants.DISTRIBUTED_TWIN_NAME] = {};
        }

        if (enable !== undefined) {
            twinPatch.properties.desired[Constants.DISTRIBUTED_TWIN_NAME].sampling_mode = enable ? 2 : 1;
        }

        if (samplingRate !== undefined) {
            twinPatch.properties.desired[Constants.DISTRIBUTED_TWIN_NAME].sampling_rate = samplingRate;
        }

        if (deviceIds.length === 1) {
            try {
                let registry = iothub.Registry.fromConnectionString(iotHubConnectionString);
                await  registry.updateTwin(deviceIds[0], JSON.stringify(twinPatch), twinPatch.etag);
                return "";
            } catch (err) {
                return err.message;
            }
        }

        const result = this.scheduleTwinUpdate(twinPatch, iotHubConnectionString, deviceIds);
        return result;
    }

    private scheduleTwinUpdate(twinPatch, iotHubConnectionString: string, deviceIds: string[]) {
        return new Promise(async (resolve, reject) => {
            let twinJobId = uuid.v4();
            let jobClient = iothub.JobClient.fromConnectionString(iotHubConnectionString);

            let queryCondition = this.generateQureyCondition(deviceIds);
            let startTime = new Date();
            let maxExecutionTimeInSeconds = 300;

            try {
                await jobClient.scheduleTwinUpdate(twinJobId, queryCondition, twinPatch, startTime, maxExecutionTimeInSeconds);
                const result = await this.monitorJob(twinJobId, jobClient);
                resolve("\nDetailed information are shown as below:\n" + JSON.stringify(result, null, 2));
            } catch (err) {
                reject("Could not monitor distributed tracing setting update job: " + err);
            }
        });
    }

    private generateQureyCondition(deviceids: string[]): string {
        const deviceIdsWithQuotes = deviceids.map((id) => "'" + id + "'");
        return `deviceId IN [${deviceIdsWithQuotes.join(",")}]`;
    }

    private async monitorJob(jobId, jobClient) {
        return new Promise(async (resolve, reject) => {
            let jobMonitorInterval = setInterval(async () => {
                try {
                    const result = await jobClient.getJob(jobId);
                    if (result.jobStatus.status === "completed" || result.jobStatus.status === "failed" || result.jobStatus.status === "cancelled") {
                        clearInterval(jobMonitorInterval);
                        resolve(result.jobStatus);
                    }
                } catch (err) {
                    reject(err);
                }
            }, 1000);
        });
    }

    private getSamplingModePickupItems(): SamplingModeItem[] {
        return [true, false].map((samplingMode) => new SamplingModeItem(samplingMode));
    }

    private async promptForSamplingRate(prompt: string, defaultValue: number): Promise<number> {
        if (defaultValue === undefined || defaultValue > 100 || defaultValue < 0) {
            defaultValue = 100;
        }

        let samplingRate: string = await vscode.window.showInputBox({ prompt, value: defaultValue.toString(), ignoreFocusOut: true, validateInput: (value): string => {
            if (value !== undefined) {
                value = value.trim();
                if (!value) {
                    return "Sampling rate cannot be empty";
                }
                const floatValue: number = parseFloat(value);
                if (!Number.isInteger(floatValue) || floatValue < 0 || floatValue > 100) {
                    return "Sampling rate should be an integer within [0, 100]";
                }
                return undefined;
            } else {
                return "Sampling rate cannot be empty";
            }
        }});

        if (samplingRate !== undefined) {
            samplingRate = samplingRate.trim();
            const floatValue: number = parseFloat(samplingRate);
            return floatValue;
        }

        return undefined;
    }
}
