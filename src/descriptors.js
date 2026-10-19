/**
 * Invocation descriptors for the `xsshOps` Remote — one source of truth
 * consumed by both the host TYPERT manifest (typert.js) and the client
 * contribution (remote.js), mirroring the shape the repo's typert generator
 * emits.
 */
import * as S from "./schemas.js";

const PACKAGE = "dsh-xssh-ops";
const NS = "xsshOps";

function def(method, requestSchema, requestType, resultSchema, resultType, options = {}) {
  return {
    id: `${PACKAGE}#${NS}/${method}`,
    service: NS,
    namespace: NS,
    method,
    // Stream methods ride the Gateway-owned WebSocket mux and deliver every
    // yielded item through the same strict result codec as unary results.
    ...(options.stream ? { mode: "stream", cancellation: { parameter: "signal" } } : {}),
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "request",
        wire: "request",
        source: "json",
        // 0.1.6-alpha.2 requires create(); alpha.1 client face reads .schema — ship both.
        codec: { mode: "strict", typeSymbol: `${PACKAGE}/types#${requestType}`, schema: requestSchema, create: () => requestSchema }
      }
    ],
    result: {
      mode: "strict",
      typeSymbol: `${PACKAGE}/types#${resultType}`,
      schema: resultSchema,
      create: () => resultSchema
    },
    sourceLocation: { file: "src/index.js", line: 1, column: 1 }
  };
}

export const DESCRIPTORS = [
  def("list", S.listRequestSchema, "SshListRequest", S.listResultSchema, "SshListResult"),
  def("connect", S.connectRequestSchema, "SshConnectRequest", S.connectResultSchema, "SshConnectResult"),
  def("credentialList", S.credentialListRequestSchema, "SshCredentialListRequest", S.credentialListResultSchema, "SshCredentialListResult"),
  def("credentialSave", S.credentialSaveRequestSchema, "SshCredentialSaveRequest", S.credentialSaveResultSchema, "SshCredentialSaveResult"),
  def("credentialDelete", S.credentialDeleteRequestSchema, "SshCredentialDeleteRequest", S.credentialDeleteResultSchema, "SshCredentialDeleteResult"),
  def("profileList", S.profileListRequestSchema, "SshProfileListRequest", S.profileListResultSchema, "SshProfileListResult"),
  def("profileSave", S.profileSaveRequestSchema, "SshProfileSaveRequest", S.profileSaveResultSchema, "SshProfileSaveResult"),
  def("profileDelete", S.profileDeleteRequestSchema, "SshProfileDeleteRequest", S.profileDeleteResultSchema, "SshProfileDeleteResult"),
  def("profileDisconnect", S.profileDisconnectRequestSchema, "SshProfileDisconnectRequest", S.profileDisconnectResultSchema, "SshProfileDisconnectResult"),
  def("profileConnect", S.profileConnectRequestSchema, "SshProfileConnectRequest", S.profileConnectResultSchema, "SshProfileConnectResult"),
  def("cancelProfileConnect", S.cancelProfileConnectRequestSchema, "SshCancelProfileConnectRequest", S.cancelProfileConnectResultSchema, "SshCancelProfileConnectResult"),
  def("groupList", S.groupListRequestSchema, "SshGroupListRequest", S.groupListResultSchema, "SshGroupListResult"),
  def("groupSave", S.groupSaveRequestSchema, "SshGroupSaveRequest", S.groupSaveResultSchema, "SshGroupSaveResult"),
  def("groupDelete", S.groupDeleteRequestSchema, "SshGroupDeleteRequest", S.groupDeleteResultSchema, "SshGroupDeleteResult"),
  def("selectConnection", S.selectConnectionRequestSchema, "SshSelectConnectionRequest", S.selectConnectionResultSchema, "SshSelectConnectionResult"),
  def("agentSettingsGet", S.agentSettingsGetRequestSchema, "SshAgentSettingsGetRequest", S.agentSettingsResultSchema, "SshAgentSettingsResult"),
  def("agentSettingsSave", S.agentSettingsSaveRequestSchema, "SshAgentSettingsSaveRequest", S.agentSettingsResultSchema, "SshAgentSettingsResult"),
  def("languageGet", S.languageGetRequestSchema, "SshLanguageGetRequest", S.languageResultSchema, "SshLanguageResult"),
  def("languageSave", S.languageSaveRequestSchema, "SshLanguageSaveRequest", S.languageResultSchema, "SshLanguageResult"),
  def("openSession", S.openSessionRequestSchema, "SshOpenSessionRequest", S.openSessionResultSchema, "SshOpenSessionResult"),
  def("listTerminalContexts", S.terminalContextListRequestSchema, "SshTerminalContextListRequest", S.terminalContextListResultSchema, "SshTerminalContextListResult"),
  def("readTerminalContext", S.terminalContextReadRequestSchema, "SshTerminalContextReadRequest", S.terminalContextReadResultSchema, "SshTerminalContextReadResult"),
  def("changeDirectory", S.changeDirectoryRequestSchema, "SshChangeDirectoryRequest", S.writeResultSchema, "SshWriteResult"),
  def("enableShellIntegration", S.enableShellIntegrationRequestSchema, "EnableShellIntegrationRequest", S.enableShellIntegrationResultSchema, "EnableShellIntegrationResult"),
  def("write", S.writeRequestSchema, "SshWriteRequest", S.writeResultSchema, "SshWriteResult"),
  def("pendingConfirmationList", S.pendingConfirmationListRequestSchema, "PendingConfirmationListRequest", S.pendingConfirmationListResultSchema, "PendingConfirmationListResult"),
  def("pendingConfirmationApprove", S.pendingConfirmationActionRequestSchema, "PendingConfirmationActionRequest", S.pendingConfirmationApproveResultSchema, "PendingConfirmationApproveResult"),
  def("pendingConfirmationCancel", S.pendingConfirmationActionRequestSchema, "PendingConfirmationActionRequest", S.pendingConfirmationCancelResultSchema, "PendingConfirmationCancelResult"),
  def("read", S.readRequestSchema, "SshReadRequest", S.readResultSchema, "SshReadResult"),
  def("terminalStream", S.terminalStreamRequestSchema, "SshTerminalStreamRequest", S.readResultSchema, "SshReadResult", { stream: true }),
  def("resize", S.resizeRequestSchema, "SshResizeRequest", S.resizeResultSchema, "SshResizeResult"),
  def("closeSession", S.closeSessionRequestSchema, "SshCloseSessionRequest", S.closeSessionResultSchema, "SshCloseSessionResult"),
  def("disconnect", S.disconnectRequestSchema, "SshDisconnectRequest", S.disconnectResultSchema, "SshDisconnectResult"),
  def("sftpList", S.sftpListRequestSchema, "SftpListRequest", S.sftpListResultSchema, "SftpListResult"),
  def("sftpStat", S.sftpStatRequestSchema, "SftpStatRequest", S.sftpStatResultSchema, "SftpStatResult"),
  def("sftpReadFile", S.sftpReadRequestSchema, "SftpReadRequest", S.sftpReadResultSchema, "SftpReadResult"),
  def("sftpWriteFile", S.sftpWriteRequestSchema, "SftpWriteRequest", S.sftpWriteResultSchema, "SftpWriteResult"),
  def("scpReadFile", S.scpReadRequestSchema, "ScpReadRequest", S.scpReadResultSchema, "ScpReadResult"),
  def("scpWriteFile", S.scpWriteRequestSchema, "ScpWriteRequest", S.scpWriteResultSchema, "ScpWriteResult"),
  def("sftpMkdir", S.sftpMkdirRequestSchema, "SftpMkdirRequest", S.sftpMkdirResultSchema, "SftpMkdirResult"),
  def("sftpDelete", S.sftpDeleteRequestSchema, "SftpDeleteRequest", S.sftpDeleteResultSchema, "SftpDeleteResult"),
  def("sftpRename", S.sftpRenameRequestSchema, "SftpRenameRequest", S.sftpRenameResultSchema, "SftpRenameResult"),
  def("sftpUploadDir", S.sftpUploadDirRequestSchema, "SftpUploadDirRequest", S.sftpTransferDirResultSchema, "SftpTransferDirResult"),
  def("sftpDownloadDir", S.sftpDownloadDirRequestSchema, "SftpDownloadDirRequest", S.sftpTransferDirResultSchema, "SftpTransferDirResult"),
  def("tunnelStartLocal", S.tunnelStartLocalRequestSchema, "TunnelStartLocalRequest", S.tunnelStartLocalResultSchema, "TunnelStartLocalResult"),
  def("tunnelStartRemote", S.tunnelStartRemoteRequestSchema, "TunnelStartRemoteRequest", S.tunnelStartRemoteResultSchema, "TunnelStartRemoteResult"),
  def("tunnelStartDynamic", S.tunnelStartDynamicRequestSchema, "TunnelStartDynamicRequest", S.tunnelStartDynamicResultSchema, "TunnelStartDynamicResult"),
  def("tunnelStop", S.tunnelStopRequestSchema, "TunnelStopRequest", S.tunnelStopResultSchema, "TunnelStopResult"),
  def("tunnelList", S.tunnelListRequestSchema, "TunnelListRequest", S.tunnelListResultSchema, "TunnelListResult"),
  def("sessionLogList", S.sessionLogListRequestSchema, "SessionLogListRequest", S.sessionLogListResultSchema, "SessionLogListResult"),
  def("sessionLogRead", S.sessionLogReadRequestSchema, "SessionLogReadRequest", S.sessionLogReadResultSchema, "SessionLogReadResult"),
  def("sessionLogSearch", S.sessionLogSearchRequestSchema, "SessionLogSearchRequest", S.sessionLogSearchResultSchema, "SessionLogSearchResult"),
  def("sessionLogDelete", S.sessionLogDeleteRequestSchema, "SessionLogDeleteRequest", S.sessionLogDeleteResultSchema, "SessionLogDeleteResult"),
  def("readTerminalLines", S.terminalLinesRequestSchema, "TerminalLinesRequest", S.terminalLinesResultSchema, "TerminalLinesResult"),
  def("sendCommand", S.commandSendRequestSchema, "CommandSendRequest", S.commandSendResultSchema, "CommandSendResult"),
  def("completeCommand", S.commandCompleteRequestSchema, "CommandCompleteRequest", S.commandCompleteResultSchema, "CommandCompleteResult"),
  def("listCommands", S.commandListRequestSchema, "CommandListRequest", S.commandListResultSchema, "CommandListResult"),
  def("keepAliveGet", S.keepAliveGetRequestSchema, "KeepAliveGetRequest", S.keepAliveGetResultSchema, "KeepAliveGetResult"),
  def("keepAliveSave", S.keepAliveSaveRequestSchema, "KeepAliveSaveRequest", S.keepAliveSaveResultSchema, "KeepAliveSaveResult"),
  def("keepAliveTest", S.keepAliveTestRequestSchema, "KeepAliveTestRequest", S.keepAliveTestResultSchema, "KeepAliveTestResult"),
  def("connectOptionsPreview", S.connectOptionsPreviewRequestSchema, "ConnectOptionsPreviewRequest", S.connectOptionsPreviewResultSchema, "ConnectOptionsPreviewResult"),
  def("taskList", S.taskListRequestSchema, "TaskListRequest", S.taskListResultSchema, "TaskListResult"),
  def("taskDegradedNotices", S.taskDegradedRequestSchema, "TaskDegradedRequest", S.taskDegradedResultSchema, "TaskDegradedResult"),
  def("taskStatus", S.taskStatusRequestSchema, "TaskStatusRequest", S.taskStatusResultSchema, "TaskStatusResult"),
  def("taskRead", S.taskReadRequestSchema, "TaskReadRequest", S.taskReadResultSchema, "TaskReadResult"),
  def("taskDelete", S.taskDeleteRequestSchema, "TaskDeleteRequest", S.taskDeleteResultSchema, "TaskDeleteResult"),
  def("listKnownHosts", S.listKnownHostsRequestSchema, "ListKnownHostsRequest", S.listKnownHostsResultSchema, "ListKnownHostsResult"),
  def("forgetHostKey", S.forgetHostKeyRequestSchema, "ForgetHostKeyRequest", S.forgetHostKeyResultSchema, "ForgetHostKeyResult"),
  def("batchPlan", S.batchPlanRequestSchema, "BatchPlanRequest", S.batchPlanResultSchema, "BatchPlanResult"),
  def("batchTaskList", S.batchTaskListRequestSchema, "BatchTaskListRequest", S.batchTaskListResultSchema, "BatchTaskListResult"),
  def("batchRun", S.batchRunRequestSchema, "BatchRunRequest", S.batchRunResultSchema, "BatchRunResult"),
  def("batchCancel", S.batchCancelRequestSchema, "BatchCancelRequest", S.batchCancelResultSchema, "BatchCancelResult"),
];
