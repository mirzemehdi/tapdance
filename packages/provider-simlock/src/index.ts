export { AxeBackend, flattenAxe, type AxeNode } from "./axe.js";
export { SimlockProvider, describeBadHealth, iosAppPredicate, parseSimctlApps, switchKnobPoint, PROVIDER_NAME, TESTED_SIMLOCK_VERSION, type SimlockProviderOptions, toAgentDeviceTarget, toUiElement, validateAppPath, checkAppId } from "./provider.js";
export { SimlockHttp, parseExecStream, type SimlockStatus, type SimlockLease, type SimlockWorker } from "./http.js";
export {
  readLocalProfile,
  remoteConnection,
  defaultProfilePath,
  clientIdFor,
  isPrivateHost,
  type SimlockConnection,
} from "./connection.js";
export * as deviceCommands from "./device-commands.js";
export type { DeviceCommand } from "./device-commands.js";
export {
  ProfileProvider,
  PROFILE_PROVIDER,
  PROFILE_NAME,
  readProfiles,
  writeProfiles,
  profilesHome,
  profileAvdHome,
  avdName,
  androidSdk,
  type ProfileRecord,
} from "./profile-provider.js";
export { fromAgentDeviceError } from "./agent-device-errors.js";
export { decodeFrames, SCREEN_FRAME_TAG, type ScreenFrame } from "./stream-framing.js";
export { releaseStaleDeviceClaims, agentDeviceCli, simlockHomeDir, type StaleClaimReport, type StaleClaimOptions } from "./stale-claims.js";
export { checkBuildRequest, runBuild, FailureDigest, isNotableBuildLine, hostSimulatorArch, XCODE_SETTING_KEYS, normalizeRepo, buildCacheDir, spawnRunner, type BuildRequest, type BuildSettings, type BuildResult, type CommandRunner } from "./build.js";
export { listCrashReports, readCrashReport, summarizeCrash, crashReportsDir, type CrashReportInfo, type CrashFilter } from "./crash-reports.js";
export { consolePaths, clearConsole, readConsole } from "./console-capture.js";
export { checkTimedTaps, orientationOf, playTouches, sequenceResult, toFramebuffer, DEFAULT_HOLD_MS, type PlayedTap, type Orientation } from "./touch-sequence.js";
