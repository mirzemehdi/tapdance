export { AxeBackend, flattenAxe, type AxeNode } from "./axe.js";
export { SimlockProvider, STALE_RECORD_REASON, describeBadHealth, iosAppPredicate, parseSimctlApps, switchKnobPoint, PROVIDER_NAME, TESTED_SIMLOCK_VERSION, type SimlockProviderOptions, toAgentDeviceTarget, toUiElement, validateAppPath, checkAppId } from "./provider.js";
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
export { androidInstallHint, BACKEND_SYNTAX, fromAgentDeviceError, installRefusal, installRefusalHint, readerHint, withInstallHintFor, type HintSurface, type InstallRefusal } from "./agent-device-errors.js";
export { readApkManifest, parseBinaryManifest, type ApkManifest } from "./apk-manifest.js";
export { settleGuest, parseGuestState, busyBetween, dialogFromDumpsys, dialogInNodes, dialogAdvice, SETTLED_CPU, SETTLED_SAMPLES, READY_BUDGET_MS, DEFAULT_CPU_CHECK_MS, MAX_CPU_CHECK_MS, fallingTrend, type GuestSample, type SystemDialog, type SettleResult } from "./guest-settle.js";
export { decodeFrames, SCREEN_FRAME_TAG, type ScreenFrame } from "./stream-framing.js";
export { releaseStaleDeviceClaims, agentDeviceCli, simlockHomeDir, type StaleClaimReport, type StaleClaimOptions } from "./stale-claims.js";
export { checkBuildRequest, runBuild, FailureDigest, isNotableBuildLine, hostSimulatorArch, hostNetworkHint, XCODE_SETTING_KEYS, normalizeRepo, buildCacheDir, spawnRunner, deployKeyFor, gitEnv, gitAuthHint, gitAuthContext, describeGitAuth, githubOverHttps, gitAccessProbe, gradleDaemonArgs, buildKey, type GitAuthContext, type GitAccess, type BuildRequest, type BuildSettings, type BuildResult, type CommandRunner } from "./build.js";
export { repoSlug, repoIdentity, repoDisplay, isSshUrl, sshFingerprint, keyFingerprint, removeRepoKey, repoKeyPath, buildFilesDir, checkBuildFilePath, addBuildFile, removeBuildFile, readBuildFiles, listAllBuildFiles, buildFilesDigest, BUILD_FILE_MAX_BYTES, BUILD_FILES_MAX, type BuildFileEntry } from "./build-files.js";
export { listCrashReports, readCrashReport, summarizeCrash, crashReportsDir, type CrashReportInfo, type CrashFilter } from "./crash-reports.js";
export { consolePaths, clearConsole, readConsole } from "./console-capture.js";
export { checkTimedTaps, orientationOf, playTouches, sequenceResult, toFramebuffer, viewportFromConfig, DEFAULT_HOLD_MS, type InputConfig, type PlayedTap, type Orientation } from "./touch-sequence.js";
export { parseIosLinkLog, parseAndroidLinkLog, type OpenedLink } from "./links.js";
export { checkCiRequest, fetchCiApk, ciAccessProbe, type CiAccess, githubRepo, ghEnv, ghFailure, readZipEntries, checkZipEntries, extractApk, artifactCacheBytes, ARTIFACT_NAME, RUN_ID, BRANCH_NAME, OWNER_GH_HINT, type CiInstallRequest, type ArtifactSettings, type CiApk, type ZipEntry } from "./ci-artifacts.js";
