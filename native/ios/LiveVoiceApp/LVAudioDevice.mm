#import "LVAudioDevice.h"

#import "LVRecordingEngine.h"

#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <mach/mach_time.h>

#import "WebRTCModuleOptions.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <vector>

namespace {

static constexpr double kDefaultSampleRate = 48000.0;
static constexpr NSTimeInterval kDefaultBufferDuration = 0.01;
static constexpr size_t kMaximumFrames = 4096;

static AudioStreamBasicDescription LVPCMDescription(double sampleRate,
                                                     UInt32 channels) {
  AudioStreamBasicDescription format = {};
  format.mSampleRate = sampleRate;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
  format.mBytesPerPacket = sizeof(int16_t) * channels;
  format.mFramesPerPacket = 1;
  format.mBytesPerFrame = sizeof(int16_t) * channels;
  format.mChannelsPerFrame = channels;
  format.mBitsPerChannel = 16;
  return format;
}

}  // namespace

@class LVAudioDevice;
NSString *const LVAudioDeviceFailedNotification = @"LVAudioDeviceFailed";
static __strong LVAudioDevice *gLVAudioDevice = nil;
static std::atomic_bool gLVAudioDeviceSessionActive{false};
static std::atomic_uint64_t gDiagnosticStart{0}, gFirstCapture{0}, gFirstPlayout{0};
static std::atomic_uint64_t gMicFrames{0}, gPlayoutFrames{0};
static std::atomic_int gMicPeak{0}, gPlayoutPeak{0};

// No allocation, logging, locks or file I/O on the real-time audio thread.
static void LVDiagnosticFrames(const int16_t *samples, UInt32 frames, UInt32 channels,
                               std::atomic_uint64_t &count, std::atomic_uint64_t &first,
                               std::atomic_int &peak) {
  uint64_t empty = 0;
  first.compare_exchange_strong(empty, mach_absolute_time());
  count.fetch_add(frames, std::memory_order_relaxed);
  int value = 0;
  for (size_t i = 0; i < static_cast<size_t>(frames) * channels; ++i)
    value = std::max(value, std::abs(static_cast<int>(samples[i])));
  int previous = peak.load(std::memory_order_relaxed);
  while (value > previous && !peak.compare_exchange_weak(previous, value)) {}
}

@interface LVAudioDevice () {
  AudioUnit _audioUnit;
  __weak id<RTC_OBJC_TYPE(RTCAudioDeviceDelegate)> _delegate;
  std::atomic_bool _initialized;
  std::atomic_bool _playoutInitialized;
  std::atomic_bool _recordingInitialized;
  std::atomic_bool _playing;
  std::atomic_bool _recording;
  std::atomic_bool _unitStarted;
  std::atomic_bool _sessionActive;
  double _sampleRate;
  NSTimeInterval _ioBufferDuration;
  NSInteger _inputChannels;
  NSInteger _outputChannels;
  std::vector<int16_t> _inputStorage;
}

- (OSStatus)renderOutput:(AudioUnitRenderActionFlags *)actionFlags
                timestamp:(const AudioTimeStamp *)timestamp
                frameCount:(UInt32)frameCount
                  ioData:(AudioBufferList *)ioData;
- (OSStatus)captureInput:(AudioUnitRenderActionFlags *)actionFlags
                timestamp:(const AudioTimeStamp *)timestamp
                frameCount:(UInt32)frameCount;
- (BOOL)configureAudioUnit;
- (BOOL)prepareAudioUnitIfNeeded;
- (BOOL)reconfigureForRoute;
- (void)routeChanged:(NSNotification *)notification;
- (void)stopDirections;
- (void)stopDirectionsSynchronously;
- (void)beginSession;
- (void)disposeAudioUnit;
- (void)notifyAudioParameters;
@end

static OSStatus LVOutputCallback(void *refCon,
                                 AudioUnitRenderActionFlags *actionFlags,
                                 const AudioTimeStamp *timestamp,
                                 UInt32 busNumber,
                                 UInt32 frameCount,
                                 AudioBufferList *ioData) {
  return [(__bridge LVAudioDevice *)refCon renderOutput:actionFlags
                                               timestamp:timestamp
                                               frameCount:frameCount
                                                 ioData:ioData];
}

static OSStatus LVInputCallback(void *refCon,
                                AudioUnitRenderActionFlags *actionFlags,
                                const AudioTimeStamp *timestamp,
                                UInt32 busNumber,
                                UInt32 frameCount,
                                AudioBufferList *ioData) {
  return [(__bridge LVAudioDevice *)refCon captureInput:actionFlags
                                               timestamp:timestamp
                                               frameCount:frameCount];
}

@implementation LVAudioDevice

- (instancetype)init {
  self = [super init];
  if (self) {
    _audioUnit = nullptr;
    _initialized.store(false);
    _playoutInitialized.store(false);
    _recordingInitialized.store(false);
    _playing.store(false);
    _recording.store(false);
    _unitStarted.store(false);
    _sessionActive.store(false);
    _sampleRate = kDefaultSampleRate;
    _ioBufferDuration = kDefaultBufferDuration;
    _inputChannels = 1;
    _outputChannels = 1;
    _inputStorage.resize(kMaximumFrames);
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(routeChanged:)
                                                 name:AVAudioSessionRouteChangeNotification
                                               object:[AVAudioSession sharedInstance]];
  }
  return self;
}

- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  [self terminateDevice];
}

- (double)deviceInputSampleRate {
  return _sampleRate;
}

- (NSTimeInterval)inputIOBufferDuration {
  return _ioBufferDuration;
}

- (NSInteger)inputNumberOfChannels {
  return _inputChannels;
}

- (NSTimeInterval)inputLatency {
  return [AVAudioSession sharedInstance].inputLatency;
}

- (double)deviceOutputSampleRate {
  return _sampleRate;
}

- (NSTimeInterval)outputIOBufferDuration {
  return _ioBufferDuration;
}

- (NSInteger)outputNumberOfChannels {
  return _outputChannels;
}

- (NSTimeInterval)outputLatency {
  return [AVAudioSession sharedInstance].outputLatency;
}

- (BOOL)isInitialized {
  return _initialized.load();
}

- (BOOL)isPlayoutInitialized {
  return _playoutInitialized.load();
}

- (BOOL)isPlaying {
  return _playing.load();
}

- (BOOL)isRecordingInitialized {
  return _recordingInitialized.load();
}

- (BOOL)isRecording {
  return _recording.load();
}

- (BOOL)initializeWithDelegate:(id<RTC_OBJC_TYPE(RTCAudioDeviceDelegate)>)delegate {
  if (_initialized.load()) return YES;
  _delegate = delegate;
  AVAudioSession *session = [AVAudioSession sharedInstance];
  if (session.sampleRate >= 8000.0) _sampleRate = session.sampleRate;
  if (session.IOBufferDuration > 0.0) _ioBufferDuration = session.IOBufferDuration;
  _sampleRate = std::clamp(_sampleRate, 8000.0, 48000.0);
  _inputChannels = 1;
  _outputChannels = 1;
  _playoutInitialized.store(false);
  _recordingInitialized.store(false);
  _initialized.store(true);
  return YES;
}

- (BOOL)terminateDevice {
  if (!_initialized.load() && _audioUnit == nullptr) {
    _delegate = nil;
    return YES;
  }
  [self stopDirections];
  [self disposeAudioUnit];
  _delegate = nil;
  _sessionActive.store(false);
  _initialized.store(false);
  _playoutInitialized.store(false);
  _recordingInitialized.store(false);
  return YES;
}

- (BOOL)initializePlayout {
  if (![self prepareAudioUnitIfNeeded]) return NO;
  [self notifyAudioParameters];
  _playoutInitialized.store(true);
  return YES;
}

- (BOOL)startPlayout {
  if (!_initialized.load() || !_playoutInitialized.load() ||
      !_sessionActive.load() || !gLVAudioDeviceSessionActive.load() ||
      _audioUnit == nullptr) return NO;
  _playing.store(true);
  if (_unitStarted.load()) return YES;
  OSStatus status = AudioOutputUnitStart(_audioUnit);
  if (status != noErr) {
    _playing.store(false);
    return NO;
  }
  _unitStarted.store(true);
  return YES;
}

- (BOOL)stopPlayout {
  _playing.store(false);
  if (!_recording.load() && _unitStarted.load() && _audioUnit != nullptr) {
    OSStatus status = AudioOutputUnitStop(_audioUnit);
    _unitStarted.store(false);
    return status == noErr;
  }
  return YES;
}

- (BOOL)initializeRecording {
  if (![self prepareAudioUnitIfNeeded]) return NO;
  [self notifyAudioParameters];
  _recordingInitialized.store(true);
  return YES;
}

- (BOOL)startRecording {
  if (!_initialized.load() || !_recordingInitialized.load() ||
      !_sessionActive.load() || !gLVAudioDeviceSessionActive.load() ||
      _audioUnit == nullptr) return NO;
  _recording.store(true);
  if (_unitStarted.load()) return YES;
  OSStatus status = AudioOutputUnitStart(_audioUnit);
  if (status != noErr) {
    _recording.store(false);
    return NO;
  }
  _unitStarted.store(true);
  return YES;
}

- (BOOL)stopRecording {
  _recording.store(false);
  if (!_playing.load() && _unitStarted.load() && _audioUnit != nullptr) {
    OSStatus status = AudioOutputUnitStop(_audioUnit);
    _unitStarted.store(false);
    return status == noErr;
  }
  return YES;
}

- (OSStatus)renderOutput:(AudioUnitRenderActionFlags *)actionFlags
                timestamp:(const AudioTimeStamp *)timestamp
                frameCount:(UInt32)frameCount
                  ioData:(AudioBufferList *)ioData {
  if (ioData == nullptr || ioData->mNumberBuffers == 0) return noErr;
  id<RTC_OBJC_TYPE(RTCAudioDeviceDelegate)> delegate = _delegate;
  if (delegate == nil || !_playing.load()) {
    for (UInt32 index = 0; index < ioData->mNumberBuffers; ++index) {
      if (ioData->mBuffers[index].mData != nullptr) {
        memset(ioData->mBuffers[index].mData, 0, ioData->mBuffers[index].mDataByteSize);
      }
    }
    return noErr;
  }
  OSStatus status = delegate.getPlayoutData(actionFlags, timestamp, 0, frameCount, ioData);
  if (status != noErr) {
    for (UInt32 index = 0; index < ioData->mNumberBuffers; ++index) {
      if (ioData->mBuffers[index].mData != nullptr) {
        memset(ioData->mBuffers[index].mData, 0, ioData->mBuffers[index].mDataByteSize);
      }
    }
    return status;
  }
  AudioBuffer *buffer = &ioData->mBuffers[0];
  if (buffer->mData != nullptr && buffer->mDataByteSize >= frameCount * sizeof(int16_t)) {
    LVDiagnosticFrames(static_cast<const int16_t *>(buffer->mData), frameCount, 1,
                       gPlayoutFrames, gFirstPlayout, gPlayoutPeak);
    [[LVRecordingEngine sharedEngine]
        offerPCM16:static_cast<const int16_t *>(buffer->mData)
        frames:frameCount
        sampleRate:_sampleRate
        channels:_outputChannels
        hostTime:timestamp != nullptr ? timestamp->mHostTime : 0
        source:LVRecordingSourceAssistant];
  }
  return noErr;
}

- (OSStatus)captureInput:(AudioUnitRenderActionFlags *)actionFlags
                timestamp:(const AudioTimeStamp *)timestamp
                frameCount:(UInt32)frameCount {
  if (!_recording.load()) return noErr;
  if (_audioUnit == nullptr || frameCount == 0 ||
      frameCount > kMaximumFrames) {
    return noErr;
  }
  AudioBufferList input = {};
  input.mNumberBuffers = 1;
  input.mBuffers[0].mNumberChannels = 1;
  input.mBuffers[0].mDataByteSize = frameCount * sizeof(int16_t);
  input.mBuffers[0].mData = _inputStorage.data();
  OSStatus status = AudioUnitRender(_audioUnit, actionFlags,
                                    timestamp, 1, frameCount, &input);
  if (status != noErr) return status;

  const uint64_t hostTime = timestamp != nullptr ? timestamp->mHostTime : 0;
  LVDiagnosticFrames(_inputStorage.data(), frameCount, 1, gMicFrames, gFirstCapture, gMicPeak);
  [[LVRecordingEngine sharedEngine]
      offerPCM16:_inputStorage.data()
      frames:frameCount
      sampleRate:_sampleRate
      channels:1
      hostTime:hostTime
      source:LVRecordingSourceMicrophone];

  id<RTC_OBJC_TYPE(RTCAudioDeviceDelegate)> delegate = _delegate;
  if (delegate != nil) {
    status = delegate.deliverRecordedData(actionFlags, timestamp, 1, frameCount,
                                          &input, nullptr, nil);
  }
  return status;
}

- (BOOL)prepareAudioUnitIfNeeded {
  if (!_initialized.load() || !gLVAudioDeviceSessionActive.load() ||
      !_sessionActive.load()) {
    return NO;
  }
  if (_audioUnit != nullptr) return YES;
  AVAudioSession *session = [AVAudioSession sharedInstance];
  if (session.sampleRate >= 8000.0) {
    _sampleRate = std::clamp(session.sampleRate, 8000.0, 48000.0);
  }
  if (session.IOBufferDuration > 0.0) {
    _ioBufferDuration = session.IOBufferDuration;
  }
  _inputChannels = 1;
  _outputChannels = 1;
  return [self configureAudioUnit];
}

- (void)notifyAudioParameters {
  id<RTC_OBJC_TYPE(RTCAudioDeviceDelegate)> delegate = _delegate;
  if (delegate == nil) return;
  [delegate dispatchSync:^{
    [delegate notifyAudioInputParametersChange];
    [delegate notifyAudioOutputParametersChange];
  }];
}

- (BOOL)configureAudioUnit {
  AudioComponentDescription description = {};
  description.componentType = kAudioUnitType_Output;
  description.componentSubType = kAudioUnitSubType_VoiceProcessingIO;
  description.componentManufacturer = kAudioUnitManufacturer_Apple;
  AudioComponent component = AudioComponentFindNext(nullptr, &description);
  if (component == nullptr) return NO;
  if (AudioComponentInstanceNew(component, &_audioUnit) != noErr ||
      _audioUnit == nullptr) {
    _audioUnit = nullptr;
    return NO;
  }

  UInt32 enabled = 1;
  if (AudioUnitSetProperty(_audioUnit, kAudioOutputUnitProperty_EnableIO,
                           kAudioUnitScope_Input, 1, &enabled,
                           sizeof(enabled)) != noErr) {
    [self disposeAudioUnit];
    return NO;
  }
  if (AudioUnitSetProperty(_audioUnit, kAudioOutputUnitProperty_EnableIO,
                           kAudioUnitScope_Output, 0, &enabled,
                           sizeof(enabled)) != noErr) {
    [self disposeAudioUnit];
    return NO;
  }

  AudioStreamBasicDescription format = LVPCMDescription(_sampleRate, 1);
  if (AudioUnitSetProperty(_audioUnit, kAudioUnitProperty_StreamFormat,
                           kAudioUnitScope_Output, 1, &format,
                           sizeof(format)) != noErr ||
      AudioUnitSetProperty(_audioUnit, kAudioUnitProperty_StreamFormat,
                           kAudioUnitScope_Input, 0, &format,
                           sizeof(format)) != noErr) {
    [self disposeAudioUnit];
    return NO;
  }

  AURenderCallbackStruct outputCallback = {};
  outputCallback.inputProc = LVOutputCallback;
  outputCallback.inputProcRefCon = (__bridge void *)self;
  if (AudioUnitSetProperty(_audioUnit, kAudioUnitProperty_SetRenderCallback,
                           kAudioUnitScope_Input, 0, &outputCallback,
                           sizeof(outputCallback)) != noErr) {
    [self disposeAudioUnit];
    return NO;
  }

  AURenderCallbackStruct inputCallback = {};
  inputCallback.inputProc = LVInputCallback;
  inputCallback.inputProcRefCon = (__bridge void *)self;
  if (AudioUnitSetProperty(_audioUnit, kAudioOutputUnitProperty_SetInputCallback,
                           kAudioUnitScope_Global, 1, &inputCallback,
                           sizeof(inputCallback)) != noErr) {
    [self disposeAudioUnit];
    return NO;
  }
  if (AudioUnitInitialize(_audioUnit) != noErr) {
    [self disposeAudioUnit];
    return NO;
  }
  return YES;
}

- (void)routeChanged:(NSNotification *)notification {
  (void)notification;
  id<RTC_OBJC_TYPE(RTCAudioDeviceDelegate)> delegate = _delegate;
  if (delegate == nil || !_initialized.load() || !_sessionActive.load() ||
      !gLVAudioDeviceSessionActive.load()) return;
  __weak LVAudioDevice *weakSelf = self;
  [delegate dispatchAsync:^{
    LVAudioDevice *strongSelf = weakSelf;
    if (strongSelf == nil || !strongSelf->_initialized.load() ||
        !strongSelf->_sessionActive.load() ||
        !gLVAudioDeviceSessionActive.load()) return;
    if ([strongSelf reconfigureForRoute]) {
      id<RTC_OBJC_TYPE(RTCAudioDeviceDelegate)> current = strongSelf->_delegate;
      if (current != nil) {
        [current notifyAudioInputParametersChange];
        [current notifyAudioOutputParametersChange];
      }
    }
  }];
}

- (BOOL)reconfigureForRoute {
  if (!_sessionActive.load() || !gLVAudioDeviceSessionActive.load()) return YES;
  if (_audioUnit == nullptr) return YES;
  AVAudioSession *session = [AVAudioSession sharedInstance];
  double newRate = session.sampleRate >= 8000.0 ? session.sampleRate : _sampleRate;
  newRate = std::clamp(newRate, 8000.0, 48000.0);
  NSTimeInterval duration = session.IOBufferDuration > 0.0
      ? session.IOBufferDuration : _ioBufferDuration;
  if (fabs(newRate - _sampleRate) < 0.5 &&
      fabs(duration - _ioBufferDuration) < 0.0001) {
    return YES;
  }
  BOOL wasStarted = _unitStarted.load();
  if (wasStarted && _audioUnit != nullptr) {
    AudioOutputUnitStop(_audioUnit);
    _unitStarted.store(false);
  }
  if (_audioUnit != nullptr) {
    AudioUnitUninitialize(_audioUnit);
    AudioComponentInstanceDispose(_audioUnit);
    _audioUnit = nullptr;
  }
  _sampleRate = newRate;
  _ioBufferDuration = duration;
  if (![self configureAudioUnit]) {
    _initialized.store(false);
    [[NSNotificationCenter defaultCenter]
        postNotificationName:LVAudioDeviceFailedNotification
                      object:nil];
    return NO;
  }
  if (wasStarted && (_playing.load() || _recording.load())) {
    if (AudioOutputUnitStart(_audioUnit) == noErr) {
      _unitStarted.store(true);
    } else {
      _initialized.store(false);
      [[NSNotificationCenter defaultCenter]
          postNotificationName:LVAudioDeviceFailedNotification
                        object:nil];
      return NO;
    }
  }
  return YES;
}

- (void)beginSession {
  _sessionActive.store(true);
  gLVAudioDeviceSessionActive.store(true);
}

- (void)stopDirections {
  _sessionActive.store(false);
  _playing.store(false);
  _recording.store(false);
  if (_unitStarted.load() && _audioUnit != nullptr) {
    AudioOutputUnitStop(_audioUnit);
    _unitStarted.store(false);
  }
  [self disposeAudioUnit];
  _playoutInitialized.store(false);
  _recordingInitialized.store(false);
}

- (void)stopDirectionsSynchronously {
  id<RTC_OBJC_TYPE(RTCAudioDeviceDelegate)> delegate = _delegate;
  if (delegate == nil) {
    [self stopDirections];
    return;
  }
  [delegate dispatchSync:^{
    [self stopDirections];
  }];
}

- (void)disposeAudioUnit {
  if (_audioUnit == nullptr) return;
  AudioUnitUninitialize(_audioUnit);
  AudioComponentInstanceDispose(_audioUnit);
  _audioUnit = nullptr;
}

@end

void LVInstallAudioDevice(void) {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    gLVAudioDevice = [[LVAudioDevice alloc] init];
    [WebRTCModuleOptions sharedInstance].audioDevice = gLVAudioDevice;
  });
}

void LVStartAudioDeviceSession(void) {
  gDiagnosticStart.store(mach_absolute_time());
  gFirstCapture.store(0); gFirstPlayout.store(0);
  gMicFrames.store(0); gPlayoutFrames.store(0);
  gMicPeak.store(0); gPlayoutPeak.store(0);
  gLVAudioDeviceSessionActive.store(true);
  [gLVAudioDevice beginSession];
}

void LVStopAudioDevice(void) {
  gLVAudioDeviceSessionActive.store(false);
  [gLVAudioDevice stopDirectionsSynchronously];
}

NSDictionary *LVAudioDiagnosticSnapshot(void) {
  mach_timebase_info_data_t timebase;
  mach_timebase_info(&timebase);
  const uint64_t start = gDiagnosticStart.load();
  auto milliseconds = [&](uint64_t value) -> double {
    return value >= start && value != 0 && start != 0
      ? static_cast<double>(value - start) * timebase.numer / timebase.denom / 1e6 : -1;
  };
  return @{ @"micFrames": @(gMicFrames.load()), @"playoutFrames": @(gPlayoutFrames.load()),
            @"micPeak": @(gMicPeak.exchange(0) / 32768.0),
            @"playoutPeak": @(gPlayoutPeak.exchange(0) / 32768.0),
            @"firstCaptureMs": @(milliseconds(gFirstCapture.load())),
            @"firstPlayoutMs": @(milliseconds(gFirstPlayout.load())) };
}
