#import <React/RCTBridgeModule.h>

#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#import <WebRTC/WebRTC.h>

#import "LVRecordingEngine.h"

#include <algorithm>
#include <atomic>

static NSString *const kRecordingDestroyed = @"recording_destroyed";

@interface VoiceRecording : NSObject <RCTBridgeModule, AVAudioPlayerDelegate>
@end

@interface VoiceRecording () {
  dispatch_queue_t _work;
  AVAudioPlayer *_player;
  NSString *_playbackID;
  BOOL _playbackPrepared;
  BOOL _playbackAudioSessionActive;
  NSString *_previousPlaybackCategory;
  NSString *_previousPlaybackMode;
  AVAudioSessionCategoryOptions _previousPlaybackOptions;
  std::atomic_bool _destroyed;
}

- (void)reject:(RCTPromiseRejectBlock)reject
           code:(NSString *)code;
- (void)stopPlaybackAndWait;
- (void)stopPlaybackInternal;
- (BOOL)startPlaybackAudioSession:(NSString * _Nullable * _Nullable)errorCode;
- (void)stopPlaybackAudioSession;
- (void)preparePlaybackInternal:(NSString *)identifier;
- (NSDictionary *)playbackStatusInternal;
- (void)finishForBackground;
- (NSString *)fixedPlaybackCode:(NSException *)exception
                       fallback:(NSString *)fallback;
@end

@implementation VoiceRecording

RCT_EXPORT_MODULE(VoiceRecording);

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _work = dispatch_queue_create("com.livevoice.recording.bridge",
                                  DISPATCH_QUEUE_SERIAL);
    _destroyed.store(false);
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(finishForBackground)
                                                 name:UIApplicationWillResignActiveNotification
                                               object:nil];
  }
  return self;
}

- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  if ([NSThread isMainThread]) {
    [self stopPlaybackInternal];
  } else {
    dispatch_sync(dispatch_get_main_queue(), ^{
      [self stopPlaybackInternal];
    });
  }
}

- (dispatch_queue_t)methodQueue {
  // AVAudioPlayer and the RTCAudioSession configuration are main-thread
  // owned. Recording catalog work is explicitly forwarded to _work below.
  return dispatch_get_main_queue();
}

- (void)invalidate {
  if (_destroyed.exchange(true)) return;
  // This method is normally called on RN's main queue. Calling synchronously
  // into _work would deadlock if a pending start is synchronously waiting for
  // the main queue to stop the player. The engine itself is lock-protected,
  // so finish the active state directly and let queued bridge calls observe
  // recording_destroyed.
  [[LVRecordingEngine sharedEngine] finishActiveSessionUnconfirmed];
  [self stopPlaybackAndWait];
}

- (void)reject:(RCTPromiseRejectBlock)reject code:(NSString *)code {
  if (reject != nil) reject(code, nil, nil);
}

- (void)finishForBackground {
  if (_destroyed.load()) return;
  // Do not finalize an ongoing voice recording just because the app is hidden.
  // The call's close/interruption path owns that lifecycle; history playback stops.
  [self stopPlaybackAndWait];
}

- (void)stopPlaybackAndWait {
  if ([NSThread isMainThread]) {
    [self stopPlaybackInternal];
    return;
  }
  dispatch_sync(dispatch_get_main_queue(), ^{
    [self stopPlaybackInternal];
  });
}

- (void)stopPlaybackInternal {
  AVAudioPlayer *player = _player;
  _player = nil;
  _playbackID = nil;
  _playbackPrepared = NO;
  [player stop];
  [self stopPlaybackAudioSession];
}

- (BOOL)startPlaybackAudioSession:(NSString * _Nullable * _Nullable)errorCode {
  if (_playbackAudioSessionActive) return YES;
  RTCAudioSession *session = [RTCAudioSession sharedInstance];
  [session lockForConfiguration];
  NSError *error = nil;
  _previousPlaybackCategory = [session.category copy];
  _previousPlaybackMode = [session.mode copy];
  _previousPlaybackOptions = session.categoryOptions;
  BOOL configured = [session setCategory:AVAudioSessionCategoryPlayback
                                   mode:AVAudioSessionModeDefault
                                options:0
                                  error:&error];
  BOOL active = configured && [session setActive:YES error:&error];
  if (!active) {
    if (_previousPlaybackCategory != nil && _previousPlaybackMode != nil) {
      [session setCategory:_previousPlaybackCategory
                      mode:_previousPlaybackMode
                   options:_previousPlaybackOptions
                     error:nil];
    }
    _previousPlaybackCategory = nil;
    _previousPlaybackMode = nil;
    _previousPlaybackOptions = 0;
  } else {
    _playbackAudioSessionActive = YES;
  }
  [session unlockForConfiguration];
  if (!active && errorCode != nullptr) *errorCode = @"recording_playback_session_failed";
  return active;
}

- (void)stopPlaybackAudioSession {
  if (!_playbackAudioSessionActive) return;
  RTCAudioSession *session = [RTCAudioSession sharedInstance];
  [session lockForConfiguration];
  [session setActive:NO error:nil];
  if (_previousPlaybackCategory != nil && _previousPlaybackMode != nil) {
    [session setCategory:_previousPlaybackCategory
                    mode:_previousPlaybackMode
                 options:_previousPlaybackOptions
                   error:nil];
  }
  [session unlockForConfiguration];
  _playbackAudioSessionActive = NO;
  _previousPlaybackCategory = nil;
  _previousPlaybackMode = nil;
  _previousPlaybackOptions = 0;
}

- (void)preparePlaybackInternal:(NSString *)identifier {
  NSURL *url = [[LVRecordingEngine sharedEngine] fileURLForIdentifier:identifier];
  if (url == nil) {
    @throw [NSException exceptionWithName:@"LiveVoiceRecording"
                                   reason:@"recording_not_found"
                                 userInfo:nil];
  }
  [self stopPlaybackInternal];
  NSError *error = nil;
  AVAudioPlayer *player = [[AVAudioPlayer alloc] initWithContentsOfURL:url
                                                                  error:&error];
  if (player == nil || ![player prepareToPlay]) {
    @throw [NSException exceptionWithName:@"LiveVoiceRecording"
                                   reason:@"recording_playback_failed"
                                 userInfo:nil];
  }
  player.delegate = self;
  _player = player;
  _playbackID = [identifier copy];
  _playbackPrepared = YES;
}

- (NSDictionary *)playbackStatusInternal {
  AVAudioPlayer *player = _player;
  if (player == nil || !_playbackPrepared) {
    return @{
      @"playing" : @NO,
      @"positionMs" : @0,
      @"durationMs" : @0,
    };
  }
  return @{
    @"id" : _playbackID ?: @"",
    @"playing" : @(player.isPlaying),
    @"positionMs" : @(llround(player.currentTime * 1000.0)),
    @"durationMs" : @(llround(player.duration * 1000.0)),
  };
}

- (NSString *)fixedPlaybackCode:(NSException *)exception
                       fallback:(NSString *)fallback {
  NSArray<NSString *> *allowed = @[
    @"recording_not_found", @"recording_playback_failed",
    @"recording_playback_session_failed"
  ];
  NSString *reason = exception.reason;
  return [allowed containsObject:reason] ? reason : fallback;
}

RCT_EXPORT_METHOD(start:(NSString *)identifier
                  mode:(NSString *)mode
             startedAt:(double)startedAt
               resolver:(RCTPromiseResolveBlock)resolve
               rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_work, ^{
    if (self->_destroyed.load()) {
      [self reject:reject code:kRecordingDestroyed];
      return;
    }
    [self stopPlaybackAndWait];
    if (self->_destroyed.load()) {
      [self reject:reject code:kRecordingDestroyed];
      return;
    }
    NSString *errorCode = nil;
    BOOL success = [[LVRecordingEngine sharedEngine] startSession:identifier
                                                              mode:mode
                                                         startedAt:startedAt
                                                        errorCode:&errorCode];
    if (!success) {
      [self reject:reject code:errorCode ?: @"recording_start_failed"];
      return;
    }
    if (resolve != nil) resolve(nil);
  });
}

RCT_EXPORT_METHOD(markConnected:(NSString *)identifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_work, ^{
    NSString *errorCode = nil;
    if (![[LVRecordingEngine sharedEngine] markSessionConnected:identifier
                                                      errorCode:&errorCode]) {
      [self reject:reject code:errorCode ?: @"recording_mark_connected_failed"];
      return;
    }
    if (resolve != nil) resolve(nil);
  });
}

RCT_EXPORT_METHOD(finish:(NSString *)identifier
                  confirmedClose:(BOOL)confirmedClose
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_work, ^{
    [self stopPlaybackAndWait];
    NSString *errorCode = nil;
    NSDictionary *info = [[LVRecordingEngine sharedEngine]
        finishSession:identifier
        confirmedClose:confirmedClose
        errorCode:&errorCode];
    if (info == nil) {
      [self reject:reject code:errorCode ?: @"recording_finish_failed"];
      return;
    }
    if (resolve != nil) resolve(info);
  });
}

RCT_EXPORT_METHOD(discard:(NSString *)identifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_work, ^{
    NSString *errorCode = nil;
    if (![[LVRecordingEngine sharedEngine] discardSession:identifier
                                                errorCode:&errorCode]) {
      [self reject:reject code:errorCode ?: @"recording_discard_failed"];
      return;
    }
    if (resolve != nil) resolve(nil);
  });
}

RCT_EXPORT_METHOD(setMuted:(NSString *)identifier
                  muted:(BOOL)muted
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_work, ^{
    NSString *errorCode = nil;
    if (![[LVRecordingEngine sharedEngine] setSessionMuted:identifier
                                                     muted:muted
                                                 errorCode:&errorCode]) {
      [self reject:reject code:errorCode ?: @"recording_mute_failed"];
      return;
    }
    if (resolve != nil) resolve(nil);
  });
}

RCT_EXPORT_METHOD(status:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_work, ^{
    if (resolve != nil) resolve([[LVRecordingEngine sharedEngine] statusSnapshot]);
  });
}

RCT_EXPORT_METHOD(list:(NSInteger)offset
                  limit:(NSInteger)limit
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_work, ^{
    NSUInteger safeOffset = offset < 0 ? 0 : static_cast<NSUInteger>(offset);
    NSUInteger safeLimit = limit <= 0 ? 50 : static_cast<NSUInteger>(limit);
    if (resolve != nil) {
      resolve([[LVRecordingEngine sharedEngine] listOffset:safeOffset limit:safeLimit]);
    }
  });
}

RCT_EXPORT_METHOD(get:(NSString *)identifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_work, ^{
    if (resolve != nil) {
      resolve([[LVRecordingEngine sharedEngine] infoForIdentifier:identifier]);
    }
  });
}

RCT_EXPORT_METHOD(delete:(NSString *)identifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_work, ^{
    [self stopPlaybackAndWait];
    NSString *errorCode = nil;
    if (![[LVRecordingEngine sharedEngine] deleteIdentifier:identifier
                                                   errorCode:&errorCode]) {
      [self reject:reject code:errorCode ?: @"recording_delete_failed"];
      return;
    }
    if (resolve != nil) resolve(nil);
  });
}

RCT_EXPORT_METHOD(preparePlayback:(NSString *)identifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  @try {
    [self preparePlaybackInternal:identifier];
    if (resolve != nil) resolve(nil);
  } @catch (NSException *exception) {
    [self stopPlaybackAudioSession];
    [self reject:reject
             code:[self fixedPlaybackCode:exception
                                  fallback:@"recording_prepare_failed"]];
  }
}

RCT_EXPORT_METHOD(play:(NSString *)identifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  @try {
    if (![_playbackID isEqualToString:identifier] ||
        _player == nil || !_playbackPrepared) {
      [self preparePlaybackInternal:identifier];
    }
    NSString *sessionError = nil;
    if (![self startPlaybackAudioSession:&sessionError]) {
      [self reject:reject code:sessionError ?: @"recording_playback_session_failed"];
      return;
    }
    if (_player.duration > 0.0 &&
        _player.currentTime >= _player.duration - 0.1) {
      _player.currentTime = 0.0;
    }
    if (![_player play]) {
      [self stopPlaybackAudioSession];
      [self reject:reject code:@"recording_playback_failed"];
      return;
    }
    if (resolve != nil) resolve(nil);
  } @catch (NSException *exception) {
    [self stopPlaybackAudioSession];
    [self reject:reject
             code:[self fixedPlaybackCode:exception
                                  fallback:@"recording_play_failed"]];
  }
}

RCT_EXPORT_METHOD(pause:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  [_player pause];
  [self stopPlaybackAudioSession];
  if (resolve != nil) resolve(nil);
}

RCT_EXPORT_METHOD(seek:(double)positionMs
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (_player == nil || !_playbackPrepared) {
    [self reject:reject code:@"recording_playback_not_ready"];
    return;
  }
  double seconds = std::max(0.0, positionMs / 1000.0);
  _player.currentTime = std::min(seconds, _player.duration);
  if (resolve != nil) resolve(nil);
}

RCT_EXPORT_METHOD(stopPlayback:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  [self stopPlaybackInternal];
  if (resolve != nil) resolve(nil);
}

RCT_EXPORT_METHOD(playbackStatus:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (resolve != nil) resolve([self playbackStatusInternal]);
}

- (void)audioPlayerDidFinishPlaying:(AVAudioPlayer *)player
                       successfully:(BOOL)flag {
  (void)player;
  (void)flag;
  [self stopPlaybackAudioSession];
}

@end
