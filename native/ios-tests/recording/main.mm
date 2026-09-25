#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <Foundation/Foundation.h>
#import <mach/mach_time.h>

#import "../../ios/LiveVoiceApp/LVRecordingEngine.h"

#include <cmath>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <unistd.h>
#include <vector>

static const double kInputRate = 48000.0;
static const double kOutputRate = 24000.0;
static const size_t kPacketFrames = 480;

static void Fail(const char *message) {
  fprintf(stderr, "recording codec test failed: %s\n", message);
  exit(1);
}

static uint64_t HostFrequency(void) {
  mach_timebase_info_data_t info;
  mach_timebase_info(&info);
  return static_cast<uint64_t>(
      1.0e9 * static_cast<double>(info.denom) / static_cast<double>(info.numer));
}

static std::vector<int16_t> Sine(double frequency, size_t frames,
                                  size_t packetIndex) {
  std::vector<int16_t> result(frames);
  const double offset = static_cast<double>(packetIndex * frames);
  for (size_t i = 0; i < frames; ++i) {
    const double phase = 2.0 * M_PI * frequency * (offset + i) / kInputRate;
    result[i] = static_cast<int16_t>(std::lround(0.4 * 32767.0 * std::sin(phase)));
  }
  return result;
}

static std::vector<int16_t> Decode(NSURL *url) {
  AVAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
  AVAssetTrack *track = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
  if (track == nil) Fail("missing audio track");
  NSError *error = nil;
  AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
  if (reader == nil) Fail("cannot create asset reader");
  NSDictionary *settings = @{
    AVFormatIDKey : @(kAudioFormatLinearPCM),
    AVSampleRateKey : @(kOutputRate),
    AVNumberOfChannelsKey : @1,
    AVLinearPCMBitDepthKey : @16,
    AVLinearPCMIsFloatKey : @NO,
    AVLinearPCMIsBigEndianKey : @NO,
    AVLinearPCMIsNonInterleaved : @NO,
  };
  AVAssetReaderTrackOutput *output =
      [[AVAssetReaderTrackOutput alloc] initWithTrack:track
                                        outputSettings:settings];
  if (![reader canAddOutput:output]) Fail("cannot add asset reader output");
  [reader addOutput:output];
  if (![reader startReading]) Fail("cannot start asset reader");
  std::vector<int16_t> result;
  CMSampleBufferRef sample = nil;
  while ((sample = [output copyNextSampleBuffer]) != nil) {
    CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
    size_t length = block == nil ? 0 : CMBlockBufferGetDataLength(block);
    size_t oldSize = result.size();
    result.resize(oldSize + length / sizeof(int16_t));
    if (length > 0) {
      CMBlockBufferCopyDataBytes(block, 0, length,
                                 result.data() + oldSize);
    }
    CFRelease(sample);
  }
  if (reader.status != AVAssetReaderStatusCompleted) Fail("asset reader failed");
  return result;
}

static NSDictionary *RunTwoTone(LVRecordingEngine *engine, NSString *identifier,
                                 BOOL muted, NSURL **urlOut) {
  NSString *errorCode = nil;
  if (![engine startSession:identifier mode:@"general" startedAt:1
                 errorCode:&errorCode]) {
    Fail("start failed");
  }
  if (![engine markSessionConnected:identifier errorCode:&errorCode]) {
    Fail("mark connected failed");
  }
  const uint64_t ticksPerSecond = HostFrequency();
  const uint64_t origin = mach_absolute_time();
  for (size_t packet = 0; packet < 40; ++packet) {
    std::vector<int16_t> mic = Sine(440.0, kPacketFrames, packet);
    std::vector<int16_t> assistant = Sine(660.0, kPacketFrames, packet);
    if (muted) {
      [engine setSessionMuted:identifier muted:YES errorCode:&errorCode];
      std::fill(assistant.begin(), assistant.end(), 0);
    }
    const int64_t jitterNs = packet % 3 == 0 ? 500000 :
        (packet % 3 == 1 ? -500000 : 0);
    const int64_t timestampNs =
        static_cast<int64_t>(packet * 10000000LL) + jitterNs;
    const uint64_t timestamp = origin +
        static_cast<uint64_t>(std::max<int64_t>(
            0, timestampNs) * static_cast<int64_t>(ticksPerSecond) / 1000000000LL);
    [engine offerPCM16:mic.data() frames:mic.size() sampleRate:kInputRate
             channels:1 hostTime:timestamp source:LVRecordingSourceMicrophone];
    [engine offerPCM16:assistant.data() frames:assistant.size() sampleRate:kInputRate
             channels:1 hostTime:timestamp source:LVRecordingSourceAssistant];
    usleep(1000);
  }
  NSDictionary *info = [engine finishSession:identifier confirmedClose:YES
                                    errorCode:&errorCode];
  if (info == nil) Fail("finish failed");
  NSURL *url = [engine fileURLForIdentifier:identifier];
  if (url == nil) Fail("missing final file");
  if (urlOut != nullptr) *urlOut = url;
  return info;
}

static void CheckTwoTone(NSArray<NSNumber *> *samples) {
  if (samples.count < 7000) Fail("unexpected duration");
  const size_t count = samples.count;
  double best = 1.0e9;
  for (int offset = -2048; offset <= 2048; ++offset) {
    size_t begin = 500;
    size_t end = count > 500 ? count - 500 : 0;
    double sum = 0.0;
    size_t compared = 0;
    for (size_t index = begin; index < end; ++index) {
      const long long source = static_cast<long long>(index) + offset;
      if (source < 0 || source >= static_cast<long long>(count)) continue;
      const double expected =
          0.2 * (std::sin(2.0 * M_PI * 440.0 * source / kOutputRate) +
                 std::sin(2.0 * M_PI * 660.0 * source / kOutputRate));
      const double actual = [samples[index] doubleValue] / 32767.0;
      sum += (actual - expected) * (actual - expected);
      ++compared;
    }
    if (compared > 0) best = std::min(best, std::sqrt(sum / compared));
  }
  if (best >= 0.1) Fail("two-tone residual too high");
}

int main(void) {
  @autoreleasepool {
    NSString *directory = [NSTemporaryDirectory()
        stringByAppendingPathComponent:
            [NSString stringWithFormat:@"live-voice-recording-test-%@",
                                       NSUUID.UUID.UUIDString]];
    LVRecordingEngine *engine =
        [[LVRecordingEngine alloc] initForTestingWithDirectory:directory];
    NSURL *toneURL = nil;
    NSDictionary *tone = RunTwoTone(engine, @"tone", NO, &toneURL);
    if ([tone[@"durationMs"] longLongValue] < 350 ||
        [tone[@"durationMs"] longLongValue] > 500) {
      Fail("duration outside expected range");
    }
    std::vector<int16_t> decoded = Decode(toneURL);
    if (decoded.size() < 7000) Fail("decoded audio too short");
    NSMutableArray<NSNumber *> *boxed = [NSMutableArray arrayWithCapacity:decoded.size()];
    for (int16_t value : decoded) [boxed addObject:@(value)];
    CheckTwoTone(boxed);
    [engine deleteIdentifier:@"tone" errorCode:nil];

    NSURL *mutedURL = nil;
    NSDictionary *muted = RunTwoTone(engine, @"muted", YES, &mutedURL);
    if ([muted[@"durationMs"] longLongValue] < 350) Fail("muted duration missing");
    std::vector<int16_t> mutedDecoded = Decode(mutedURL);
    double mutedEnergy = 0.0;
    for (int16_t value : mutedDecoded) {
      const double normalized = static_cast<double>(value) / 32767.0;
      mutedEnergy += normalized * normalized;
    }
    mutedEnergy = mutedDecoded.empty()
        ? 1.0 : std::sqrt(mutedEnergy / mutedDecoded.size());
    if (mutedEnergy >= 0.03) Fail("muted microphone was not silent");
    [engine deleteIdentifier:@"muted" errorCode:nil];

    NSString *errorCode = nil;
    if (![engine startSession:@"unconnected" mode:@"general" startedAt:1
                   errorCode:&errorCode]) {
      Fail("unconnected start failed");
    }
    int16_t silence[kPacketFrames] = {};
    if ([engine offerPCM16:silence frames:kPacketFrames sampleRate:kInputRate
                  channels:1 hostTime:mach_absolute_time()
                  source:LVRecordingSourceMicrophone]) {
      Fail("unconnected offer unexpectedly accepted");
    }
    if (![engine discardSession:@"unconnected" errorCode:&errorCode] ||
        [engine infoForIdentifier:@"unconnected"] != nil) {
      Fail("unconnected discard left a recording");
    }

    for (NSUInteger index = 0; index < 12; ++index) {
      NSString *identifier = [NSString stringWithFormat:@"recycle-%lu",
                                                        (unsigned long)index];
      if (![engine startSession:identifier mode:@"general" startedAt:1
                     errorCode:&errorCode] ||
          ![engine markSessionConnected:identifier errorCode:&errorCode] ||
          ![engine offerPCM16:silence frames:kPacketFrames sampleRate:kInputRate
                    channels:1 hostTime:mach_absolute_time()
                    source:LVRecordingSourceAssistant]) {
        Fail("resource recycle session failed");
      }
      if ([engine finishSession:identifier confirmedClose:YES
                      errorCode:&errorCode] == nil) {
        Fail("resource recycle finish failed");
      }
      [engine deleteIdentifier:identifier errorCode:nil];
    }
    [[NSFileManager defaultManager] removeItemAtPath:directory error:nil];
    printf("iOS recording codec test passed: continuous resample, jitter, mute, "
           "duration, discard, and session recycle\n");
  }
  return 0;
}
