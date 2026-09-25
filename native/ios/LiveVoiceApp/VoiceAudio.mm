#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>

#import <React/RCTEventEmitter.h>
#import <React/RCTLog.h>

#import <WebRTC/WebRTC.h>
#import "LVAudioDevice.h"

static NSString *const kVoiceAudioFocusLost = @"VoiceAudioFocusLost";
static NSString *const kAudioError = @"audio_error";
static NSString *const kMicrophonePermission = @"mic_permission";

/**
 * Owns the iOS audio-session activation and route. LVAudioDevice owns the
 * VoiceProcessingIO unit and PCM callbacks; this module stops that device
 * before restoring the previous AVAudioSession configuration.
 */
@interface VoiceAudioModule : RCTEventEmitter <RTC_OBJC_TYPE(RTCAudioSessionDelegate)>
@end

@interface VoiceAudioModule () {
  RTCAudioSession *_audioSession;
  BOOL _started;
  BOOL _invalidated;
  BOOL _ownsActivation;
  BOOL _speakerOverridden;
  BOOL _conversationConnected;
  BOOL _previousProximityMonitoring;
  BOOL _ownsProximityMonitoring;
  BOOL _routeUpdateScheduled;
  BOOL _permissionRequestInFlight;
  BOOL _ownsIdleTimer;
  BOOL _previousIdleTimerDisabled;
  NSUInteger _operationGeneration;
  NSString *_previousCategory;
  NSString *_previousMode;
  AVAudioSessionCategoryOptions _previousCategoryOptions;
}
@end

@implementation VoiceAudioModule

RCT_EXPORT_MODULE(VoiceAudio);

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

- (dispatch_queue_t)methodQueue {
  return dispatch_get_main_queue();
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _audioSession = [RTCAudioSession sharedInstance];
    [_audioSession addDelegate:self];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(audioDeviceFailed:)
                                                name:LVAudioDeviceFailedNotification object:nil];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(applicationWillResignActive:)
                                                name:UIApplicationWillResignActiveNotification object:nil];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(applicationDidBecomeActive:)
                                                name:UIApplicationDidBecomeActiveNotification object:nil];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(automaticRouteChanged:)
                                                name:AVAudioSessionRouteChangeNotification object:nil];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(automaticRouteChanged:)
                                                name:UIDeviceProximityStateDidChangeNotification object:nil];
  }
  return self;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[ kVoiceAudioFocusLost, @"VoiceAudioRouteChanged", @"VoiceAudioRouteFailed" ];
}

- (void)invalidate {
  if (!_invalidated) {
    _invalidated = YES;
    _operationGeneration += 1;
    _permissionRequestInFlight = NO;
    if ([NSThread isMainThread]) [self stopInternal];
    else dispatch_async(dispatch_get_main_queue(), ^{ [self stopInternal]; });
    [_audioSession removeDelegate:self];
    [[NSNotificationCenter defaultCenter] removeObserver:self];
  }
  [super invalidate];
}

RCT_EXPORT_METHOD(start:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (_invalidated) {
    reject(kAudioError, nil, nil);
    return;
  }
  if (_started) {
    resolve(nil);
    return;
  }
  if (_permissionRequestInFlight) {
    reject(kAudioError, nil, nil);
    return;
  }

  AVAudioSession *systemSession = [AVAudioSession sharedInstance];
  AVAudioSessionRecordPermission permission = systemSession.recordPermission;
  if (permission == AVAudioSessionRecordPermissionDenied) {
    reject(kMicrophonePermission, nil, nil);
    return;
  }

  if (permission == AVAudioSessionRecordPermissionUndetermined) {
    _permissionRequestInFlight = YES;
    NSUInteger generation = ++_operationGeneration;
    [systemSession requestRecordPermission:^(BOOL granted) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (generation != self->_operationGeneration || self->_invalidated) {
          self->_permissionRequestInFlight = NO;
          reject(kAudioError, nil, nil);
          return;
        }
        self->_permissionRequestInFlight = NO;
        if (!granted) {
          reject(kMicrophonePermission, nil, nil);
          return;
        }
        [self activateWithResolve:resolve rejecter:reject];
      });
    }];
    return;
  }

  [self activateWithResolve:resolve rejecter:reject];
}

// Ask before JS creates a session attempt: the iOS permission sheet temporarily
// makes the app inactive and must not cancel the attempt being created.
RCT_EXPORT_METHOD(requestPermission:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (_invalidated) { reject(kAudioError, nil, nil); return; }
  [[AVAudioSession sharedInstance] requestRecordPermission:^(BOOL granted) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self->_invalidated) reject(kAudioError, nil, nil);
      else if (granted) resolve(nil);
      else reject(kMicrophonePermission, nil, nil);
    });
  }];
}

RCT_EXPORT_METHOD(setSpeaker:(BOOL)enabled
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (_invalidated || !_started) {
    reject(kAudioError, nil, nil);
    return;
  }

  [_audioSession lockForConfiguration];
  NSError *error = nil;
  AVAudioSessionPortOverride override =
      enabled ? AVAudioSessionPortOverrideSpeaker : AVAudioSessionPortOverrideNone;
  BOOL success = [_audioSession overrideOutputAudioPort:override error:&error];
  [_audioSession unlockForConfiguration];

  if (!success) {
    reject(kAudioError, nil, nil);
    return;
  }
  _speakerOverridden = enabled;
  resolve(nil);
}

RCT_EXPORT_METHOD(conversationConnected:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (!_started || _invalidated) { reject(kAudioError, nil, nil); return; }
  _conversationConnected = YES;
  [self applyAutomaticRoute];
  resolve(nil);
}

RCT_EXPORT_METHOD(getRoute:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  resolve([self routeSnapshot]);
}

- (NSDictionary *)routeSnapshot {
  NSString *output = @"system";
  for (AVAudioSessionPortDescription *port in AVAudioSession.sharedInstance.currentRoute.outputs) {
    NSString *type = port.portType;
    if ([type isEqual:AVAudioSessionPortBuiltInSpeaker]) output = @"speaker";
    else if ([type isEqual:AVAudioSessionPortBuiltInReceiver]) output = @"receiver";
    else if ([type isEqual:AVAudioSessionPortBluetoothHFP] || [type isEqual:AVAudioSessionPortBluetoothA2DP] || [type isEqual:AVAudioSessionPortBluetoothLE]) { output = @"bluetooth"; break; }
    else { output = @"headphones"; break; }
  }
  return @{ @"output": _started ? output : @"system", @"automatic": @YES };
}

- (void)automaticRouteChanged:(NSNotification *)notification {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!self->_started || self->_invalidated || self->_routeUpdateScheduled) return;
    self->_routeUpdateScheduled = YES;
    const NSUInteger generation = self->_operationGeneration;
    // Coalesce the category and hardware notifications from one route change.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      self->_routeUpdateScheduled = NO;
      if (generation == self->_operationGeneration && self->_started && !self->_invalidated) [self applyAutomaticRoute];
    });
  });
}

- (void)applyAutomaticRoute {
  if (!_started || _invalidated) return;
  AVAudioSession *session = AVAudioSession.sharedInstance;
  BOOL external = NO;
  for (AVAudioSessionPortDescription *port in session.currentRoute.outputs) {
    if (![port.portType isEqual:AVAudioSessionPortBuiltInSpeaker] &&
        ![port.portType isEqual:AVAudioSessionPortBuiltInReceiver]) external = YES;
  }
  UIDevice *device = UIDevice.currentDevice;
  if (!_ownsProximityMonitoring && _conversationConnected) {
    _previousProximityMonitoring = device.proximityMonitoringEnabled;
    _ownsProximityMonitoring = YES;
  }
  if (_ownsProximityMonitoring) device.proximityMonitoringEnabled = !external;
  BOOL near = !external && _conversationConnected && device.proximityMonitoringEnabled && device.proximityState;
  // DefaultToSpeaker changes only the built-in fallback. Unlike Speaker
  // override it leaves Bluetooth/wired devices and their microphones to iOS.
  AVAudioSessionCategoryOptions options = session.categoryOptions | AVAudioSessionCategoryOptionAllowBluetooth;
  if (near) options &= ~AVAudioSessionCategoryOptionDefaultToSpeaker;
  else options |= AVAudioSessionCategoryOptionDefaultToSpeaker;
  if (options != session.categoryOptions) {
    [_audioSession lockForConfiguration];
    NSError *error = nil;
    BOOL applied = [_audioSession setCategory:AVAudioSessionCategoryPlayAndRecord mode:AVAudioSessionModeVoiceChat options:options error:&error];
    [_audioSession unlockForConfiguration];
    if (!applied) [self sendEventWithName:@"VoiceAudioRouteFailed" body:nil];
  }
  [self sendEventWithName:@"VoiceAudioRouteChanged" body:[self routeSnapshot]];
}

RCT_EXPORT_METHOD(stop:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  _operationGeneration += 1;
  _permissionRequestInFlight = NO;
  if ([self stopInternal]) {
    resolve(nil);
  } else {
    reject(kAudioError, nil, nil);
  }
}

RCT_EXPORT_METHOD(diagnosticAudio:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(LVAudioDiagnosticSnapshot());
}

// One bounded, local-only snapshot; overwritten by the next session. The JS
// collector accepts only enumerated events and numeric counters, never content.
RCT_EXPORT_METHOD(writeDiagnostic:(NSDictionary *)snapshot
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  static dispatch_queue_t diagnosticQueue;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    diagnosticQueue = dispatch_queue_create("com.livevoice.diagnostics", DISPATCH_QUEUE_SERIAL);
  });
  dispatch_async(diagnosticQueue, ^{
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:&error];
    if (!data || data.length > 65536) { reject(@"diagnostic_failed", nil, nil); return; }
    NSURL *base = [[[NSFileManager defaultManager] URLsForDirectory:NSCachesDirectory
                                                      inDomains:NSUserDomainMask] firstObject];
    NSURL *directory = [base URLByAppendingPathComponent:@"LiveVoiceDiagnostics" isDirectory:YES];
    BOOL created = [[NSFileManager defaultManager] createDirectoryAtURL:directory
                        withIntermediateDirectories:YES attributes:nil error:&error];
    BOOL saved = created && [data writeToURL:[directory URLByAppendingPathComponent:@"latest.json"]
                              options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication
                              error:&error];
    if (saved) resolve(nil); else reject(@"diagnostic_failed", nil, nil);
  });
}

- (void)activateWithResolve:(RCTPromiseResolveBlock)resolve
                    rejecter:(RCTPromiseRejectBlock)reject {
  if (_invalidated) {
    reject(kAudioError, nil, nil);
    return;
  }

  _previousCategory = [_audioSession.category copy];
  _previousMode = [_audioSession.mode copy];
  _previousCategoryOptions = _audioSession.categoryOptions;

  [_audioSession lockForConfiguration];
  NSError *error = nil;
  RTCAudioSessionConfiguration *configuration =
      [RTCAudioSessionConfiguration webRTCConfiguration];
  configuration.categoryOptions |= AVAudioSessionCategoryOptionAllowBluetooth | AVAudioSessionCategoryOptionDefaultToSpeaker;

  // A Bluetooth route may not accept every preferred sample-rate or channel
  // hint. Those hints are optimizations; category/mode and activation remain
  // required for the session.
  BOOL previousIgnore = _audioSession.ignoresPreferredAttributeConfigurationErrors;
  _audioSession.ignoresPreferredAttributeConfigurationErrors = YES;
  BOOL configured = [_audioSession setConfiguration:configuration error:&error];
  _audioSession.ignoresPreferredAttributeConfigurationErrors = previousIgnore;

  if (!configured) {
    [self restoreConfigurationLocked];
    [_audioSession unlockForConfiguration];
    [self clearState];
    reject(kAudioError, nil, nil);
    return;
  }

  // Keep this activation balanced by stopInternal. WebRTC's own audio device
  // may hold another activation; RTCAudioSession counts those independently.
  BOOL activated = [_audioSession setActive:YES error:&error];
  if (!activated) {
    [self restoreConfigurationLocked];
    [_audioSession unlockForConfiguration];
    [self clearState];
    reject(kAudioError, nil, nil);
    return;
  }
  _ownsActivation = YES;

  BOOL routed = [_audioSession overrideOutputAudioPort:AVAudioSessionPortOverrideNone error:&error];
  if (!routed) {
    [_audioSession setActive:NO error:nil];
    _ownsActivation = NO;
    [self restoreConfigurationLocked];
    [_audioSession unlockForConfiguration];
    [self clearState];
    reject(kAudioError, nil, nil);
    return;
  }

  _speakerOverridden = NO;
  LVStartAudioDeviceSession();
  _started = YES;
  [_audioSession unlockForConfiguration];
  [self applyAutomaticRoute];
  [self keepScreenAwake];
  resolve(nil);
}

- (void)keepScreenAwake {
  UIApplication *application = UIApplication.sharedApplication;
  if (_ownsIdleTimer || application.applicationState != UIApplicationStateActive) return;
  _previousIdleTimerDisabled = application.idleTimerDisabled;
  _ownsIdleTimer = YES;
  application.idleTimerDisabled = YES;
}

- (void)restoreIdleTimer {
  // React invalidation can arrive outside the module's main method queue.
  if (![NSThread isMainThread]) {
    dispatch_async(dispatch_get_main_queue(), ^{ [self restoreIdleTimer]; });
    return;
  }
  if (!_ownsIdleTimer) return;
  UIApplication.sharedApplication.idleTimerDisabled = _previousIdleTimerDisabled;
  _ownsIdleTimer = NO;
}

- (void)applicationWillResignActive:(NSNotification *)notification {
  // Background audio continues, but only the foreground owns screen wakefulness.
  [self restoreIdleTimer];
}

- (void)applicationDidBecomeActive:(NSNotification *)notification {
  if (_started && !_invalidated) [self keepScreenAwake];
}

- (BOOL)stopInternal {
  _conversationConnected = NO;
  if (_ownsProximityMonitoring) {
    UIDevice.currentDevice.proximityMonitoringEnabled = _previousProximityMonitoring;
    _ownsProximityMonitoring = NO;
  }
  [self restoreIdleTimer];
  if (_started || _ownsActivation) {
    [[NSNotificationCenter defaultCenter] postNotificationName:@"LiveVoiceSessionAudioStopped" object:nil];
  }
  LVStopAudioDevice();
  if (!_started && !_ownsActivation && !_speakerOverridden &&
      _previousCategory == nil) {
    return YES;
  }

  BOOL success = YES;
  [_audioSession lockForConfiguration];
  NSError *error = nil;
  if (_speakerOverridden &&
      ![_audioSession overrideOutputAudioPort:AVAudioSessionPortOverrideNone
                                        error:&error]) {
    success = NO;
  }
  _speakerOverridden = NO;

  if (_ownsActivation && ![_audioSession setActive:NO error:&error]) {
    success = NO;
  }
  _ownsActivation = NO;

  if (![self restoreConfigurationLocked]) {
    success = NO;
  }
  [_audioSession unlockForConfiguration];
  [self clearState];
  return success;
}

- (BOOL)restoreConfigurationLocked {
  if (_previousCategory == nil || _previousMode == nil) {
    return YES;
  }
  NSError *error = nil;
  return [_audioSession setCategory:_previousCategory
                               mode:_previousMode
                            options:_previousCategoryOptions
                              error:&error];
}

- (void)clearState {
  _started = NO;
  _ownsActivation = NO;
  _speakerOverridden = NO;
  _conversationConnected = NO;
  _previousCategory = nil;
  _previousMode = nil;
  _previousCategoryOptions = 0;
}

- (void)emitFocusLost {
  void (^emit)(void) = ^{
    [self restoreIdleTimer];
    [[NSNotificationCenter defaultCenter] postNotificationName:@"LiveVoiceSessionAudioStopped" object:nil];
    if (!self->_invalidated) {
      [self sendEventWithName:kVoiceAudioFocusLost body:nil];
    }
  };
  if ([NSThread isMainThread]) {
    emit();
  } else {
    dispatch_async(dispatch_get_main_queue(), emit);
  }
}

- (void)audioSessionDidBeginInterruption:(RTCAudioSession *)session {
  [self emitFocusLost];
}

- (void)audioDeviceFailed:(NSNotification *)notification {
  [self emitFocusLost];
}

- (void)audioSessionMediaServerTerminated:(RTCAudioSession *)session {
  [self emitFocusLost];
}

- (void)audioSessionMediaServerReset:(RTCAudioSession *)session {
  [self emitFocusLost];
}

@end
