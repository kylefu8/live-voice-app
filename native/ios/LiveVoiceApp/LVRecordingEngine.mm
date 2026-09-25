#import "LVRecordingEngine.h"

#import <AudioToolbox/AudioToolbox.h>
#import <AVFoundation/AVFoundation.h>
#import <TargetConditionals.h>
#import <mach/mach_time.h>
#import <os/lock.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

static constexpr double kOutputSampleRate = 24000.0;
static constexpr size_t kOutputFrameSamples = 240;
static constexpr size_t kMaxPacketFrames = 2048;
static constexpr size_t kPacketQueueCapacity = 96;
static constexpr int64_t kTimelineReanchorFrames = 6000;
static constexpr int64_t kRenderHoldFrames = 6000;
static constexpr int64_t kMinimumFreeBytes = 64LL * 1024LL * 1024LL;

enum LVErrorIndex : int {
  LVErrorNone = 0,
  LVErrorStorageFull,
  LVErrorStorageFailed,
  LVErrorEncoderFailed,
  LVErrorWriteFailed,
  LVErrorFinishTimeout,
  LVErrorNoAudio,
  LVErrorIdExists,
  LVErrorInterrupted,
  LVErrorQueueFull,
};

static NSString *LVErrorString(LVErrorIndex index) {
  switch (index) {
    case LVErrorStorageFull: return @"recording_storage_full";
    case LVErrorStorageFailed: return @"recording_storage_failed";
    case LVErrorEncoderFailed: return @"recording_encoder_failed";
    case LVErrorWriteFailed: return @"recording_write_failed";
    case LVErrorFinishTimeout: return @"recording_finish_timeout";
    case LVErrorNoAudio: return @"recording_no_audio";
    case LVErrorIdExists: return @"recording_id_exists";
    case LVErrorInterrupted: return @"recording_interrupted";
    case LVErrorQueueFull: return @"recording_queue_full";
    case LVErrorNone: break;
  }
  return nil;
}

static void LVSetError(NSString * _Nullable * _Nullable destination,
                       NSString * _Nullable value) {
  if (destination != nullptr) *destination = value;
}

static BOOL LVValidIdentifier(NSString *identifier) {
  if (identifier.length == 0 || identifier.length > 128) return NO;
  NSCharacterSet *allowed =
      [NSCharacterSet characterSetWithCharactersInString:
       @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"];
  return [identifier rangeOfCharacterFromSet:[allowed invertedSet]].location == NSNotFound;
}

static BOOL LVValidMode(NSString *mode) {
  return [mode isEqualToString:@"general"] || [mode isEqualToString:@"practice"];
}

static uint64_t LVNowHostTime(void) {
  return mach_absolute_time();
}

static double LVHostTimeFrequency(void) {
  static double frequency = 0.0;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    mach_timebase_info_data_t info;
    mach_timebase_info(&info);
    frequency = info.denom == 0
        ? 1.0e9
        : 1.0e9 * static_cast<double>(info.denom) / static_cast<double>(info.numer);
  });
  return frequency;
}

static int64_t LVRelativeFrames(uint64_t timestamp, uint64_t origin) {
  if (timestamp <= origin) return 0;
  const double seconds = static_cast<double>(timestamp - origin) / LVHostTimeFrequency();
  return static_cast<int64_t>(llround(seconds * kOutputSampleRate));
}

static void LVApplyFileAttributes(NSString *path) {
#if TARGET_OS_IPHONE
  NSURL *url = [NSURL fileURLWithPath:path];
  [url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
  [[NSFileManager defaultManager]
      setAttributes:@{NSFileProtectionKey : NSFileProtectionCompleteUntilFirstUserAuthentication}
         ofItemAtPath:path
              error:nil];
#else
  (void)path;
#endif
}

static NSString *LVRecordingDirectory(void) {
  NSArray<NSURL *> *urls =
      [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
                                               inDomains:NSUserDomainMask];
  NSURL *base = urls.firstObject;
  if (base == nil) base = [NSURL fileURLWithPath:NSTemporaryDirectory() isDirectory:YES];
  NSURL *directory = [base URLByAppendingPathComponent:@"LiveVoiceRecordings"
                                            isDirectory:YES];
#if TARGET_OS_IPHONE
  NSDictionary *attributes =
      @{NSFileProtectionKey : NSFileProtectionCompleteUntilFirstUserAuthentication};
#else
  NSDictionary *attributes = nil;
#endif
  [[NSFileManager defaultManager] createDirectoryAtURL:directory
                            withIntermediateDirectories:YES
                                             attributes:attributes
                                                  error:nil];
#if TARGET_OS_IPHONE
  [directory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
#endif
  return directory.path;
}

static BOOL LVHasEnoughSpace(NSString *directory) {
  NSDictionary *attributes =
      [[NSFileManager defaultManager] attributesOfFileSystemForPath:directory error:nil];
  NSNumber *freeBytes = attributes[NSFileSystemFreeSize];
  return freeBytes != nil && freeBytes.longLongValue >= kMinimumFreeBytes;
}

struct LVAudioPacket {
  LVRecordingSource source = LVRecordingSourceMicrophone;
  uint64_t hostTime = 0;
  double sampleRate = 0.0;
  uint16_t channels = 1;
  uint32_t frames = 0;
  bool muted = false;
  int16_t samples[kMaxPacketFrames * 2] = {};
};

class LVTimeline {
 public:
  int64_t endFrame() const {
    return initialized_ ? baseFrame_ + static_cast<int64_t>(samples_.size()) : baseFrame_;
  }

  void append(int64_t startFrame, const std::vector<float> &incoming) {
    if (incoming.empty()) return;
    if (!initialized_) {
      initialized_ = true;
      baseFrame_ = startFrame;
      samples_ = incoming;
      return;
    }
    const int64_t end = endFrame();
    if (startFrame > end + kTimelineReanchorFrames) {
      baseFrame_ = startFrame;
      samples_ = incoming;
      return;
    }
    if (startFrame >= end) {
      if (startFrame > end) {
        samples_.resize(samples_.size() + static_cast<size_t>(startFrame - end), 0.0f);
      }
      samples_.insert(samples_.end(), incoming.begin(), incoming.end());
      return;
    }
    size_t skip = 0;
    if (startFrame < baseFrame_) {
      const int64_t difference = baseFrame_ - startFrame;
      skip = difference >= static_cast<int64_t>(incoming.size())
          ? incoming.size()
          : static_cast<size_t>(difference);
      startFrame = baseFrame_;
    }
    if (skip >= incoming.size()) return;
    const int64_t currentEnd = endFrame();
    if (startFrame < currentEnd) {
      const int64_t overlap = currentEnd - startFrame;
      if (overlap >= static_cast<int64_t>(incoming.size() - skip)) return;
      skip += static_cast<size_t>(overlap);
    }
    samples_.insert(samples_.end(), incoming.begin() + static_cast<ptrdiff_t>(skip),
                    incoming.end());
  }

  float sampleAt(int64_t frame) const {
    if (!initialized_ || frame < baseFrame_ || frame >= endFrame()) return 0.0f;
    return samples_[static_cast<size_t>(frame - baseFrame_)];
  }

  void trimBefore(int64_t frame) {
    if (!initialized_ || frame <= baseFrame_) return;
    if (frame >= endFrame()) {
      samples_.clear();
      baseFrame_ = frame;
      initialized_ = false;
      return;
    }
    const size_t count = static_cast<size_t>(frame - baseFrame_);
    samples_.erase(samples_.begin(), samples_.begin() + static_cast<ptrdiff_t>(count));
    baseFrame_ = frame;
  }

 private:
  bool initialized_ = false;
  int64_t baseFrame_ = 0;
  std::vector<float> samples_;
};

static std::vector<float> LVMixDown(const LVAudioPacket &packet) {
  if (packet.frames == 0 || packet.channels == 0) return {};
  std::vector<float> result(packet.frames, 0.0f);
  for (size_t frame = 0; frame < packet.frames; ++frame) {
    float sum = 0.0f;
    for (size_t channel = 0; channel < packet.channels; ++channel) {
      sum += static_cast<float>(
          packet.samples[frame * packet.channels + channel]) / 32768.0f;
    }
    result[frame] = std::clamp(
        sum / static_cast<float>(packet.channels), -1.0f, 1.0f);
  }
  if (packet.muted) std::fill(result.begin(), result.end(), 0.0f);
  return result;
}

/**
 * Resamples one source as a continuous stream.  The fractional source
 * position and the final input sample are retained between packets, so a
 * 48k -> 24k stream emits exactly one output sample for every two input
 * samples across packet boundaries.  Packet timestamps never participate in
 * ordinary placement; they are only used by LVSourceState for first-anchor
 * and substantial-forward-gap detection.
 */
class LVContinuousResampler {
 public:
  void reset(double sampleRate) {
    sampleRate_ = sampleRate;
    step_ = sampleRate / kOutputSampleRate;
    initialized_ = sampleRate > 0.0;
    inputBase_ = 0;
    inputCount_ = 0;
    nextInputPosition_ = 0.0;
    samples_.clear();
  }

  bool initialized() const { return initialized_; }
  double sampleRate() const { return sampleRate_; }

  std::vector<float> append(const std::vector<float> &input, bool flush) {
    if (!initialized_) return {};
    if (!input.empty()) {
      samples_.insert(samples_.end(), input.begin(), input.end());
      inputCount_ += static_cast<int64_t>(input.size());
    }
    if (input.empty() && !flush) return {};
    std::vector<float> result;
    while (true) {
      const bool hasInterpolationPair =
          nextInputPosition_ + 1.0 < static_cast<double>(inputCount_);
      const bool hasFlushSample =
          flush && nextInputPosition_ < static_cast<double>(inputCount_);
      if (!hasInterpolationPair && !hasFlushSample) break;
      const int64_t beforeAbsolute =
          static_cast<int64_t>(floor(nextInputPosition_));
      const int64_t afterAbsolute = std::min(
          inputCount_ - 1, beforeAbsolute + 1);
      const int64_t beforeIndex = beforeAbsolute - inputBase_;
      const int64_t afterIndex = afterAbsolute - inputBase_;
      if (beforeIndex < 0 || afterIndex < 0 ||
          beforeIndex >= static_cast<int64_t>(samples_.size()) ||
          afterIndex >= static_cast<int64_t>(samples_.size())) {
        break;
      }
      const float fraction = static_cast<float>(
          std::clamp(nextInputPosition_ - static_cast<double>(beforeAbsolute),
                     0.0, 1.0));
      result.push_back(samples_[static_cast<size_t>(beforeIndex)] +
                       (samples_[static_cast<size_t>(afterIndex)] -
                        samples_[static_cast<size_t>(beforeIndex)]) * fraction);
      nextInputPosition_ += step_;
    }
    trimBefore(static_cast<int64_t>(floor(nextInputPosition_)) - 1);
    return result;
  }

 private:
  void trimBefore(int64_t absoluteFrame) {
    if (absoluteFrame <= inputBase_) return;
    const int64_t available = inputCount_ - inputBase_;
    const int64_t count = std::min(available, absoluteFrame - inputBase_);
    if (count <= 0) return;
    samples_.erase(samples_.begin(),
                   samples_.begin() + static_cast<ptrdiff_t>(count));
    inputBase_ += count;
  }

  bool initialized_ = false;
  double sampleRate_ = 0.0;
  double step_ = 1.0;
  int64_t inputBase_ = 0;
  int64_t inputCount_ = 0;
  double nextInputPosition_ = 0.0;
  std::vector<float> samples_;
};

struct LVSourceState {
  bool seen = false;
  uint64_t lastHostTime = 0;
  uint32_t lastInputFrames = 0;
  double lastSampleRate = 0.0;
  bool hasOutputAnchor = false;
  int64_t nextOutputFrame = 0;
  LVContinuousResampler resampler;
};

class LVSessionState {
 public:
  LVSessionState(std::string identifier, std::string mode, uint64_t startedAt,
                 std::string directory)
      : identifier_(std::move(identifier)),
        mode_(std::move(mode)),
        startedAt_(startedAt),
        directory_(std::move(directory)),
        finalPath_(directory_ + "/" + identifier_ + ".m4a"),
        partialPath_(directory_ + "/" + identifier_ + ".m4a.part"),
        metadataPath_(directory_ + "/" + identifier_ + ".json") {
    worker_ = std::thread([this] { run(); });
  }

  ~LVSessionState() {
    discard();
    if (worker_.joinable()) worker_.join();
  }

  const std::string &identifier() const { return identifier_; }
  const std::string &mode() const { return mode_; }
  uint64_t startedAt() const { return startedAt_; }

  bool markConnected() {
    if (discarded_.load() || !accepting_.load()) return false;
    connected_.store(true);
    return true;
  }

  void setMuted(bool value) { muted_.store(value); }

  bool offer(const int16_t *samples, size_t frames, double sampleRate,
             size_t channels, uint64_t hostTime, LVRecordingSource source) {
    if (samples == nullptr || frames == 0 || frames > kMaxPacketFrames ||
        channels == 0 || channels > 2 || sampleRate < 8000.0 || sampleRate > 96000.0 ||
        !accepting_.load() || !connected_.load() || discarded_.load()) {
      return false;
    }
    os_unfair_lock_lock(&queueLock_);
    if (!accepting_.load() || !connected_.load()) {
      os_unfair_lock_unlock(&queueLock_);
      return false;
    }
    if (queueCount_ >= kPacketQueueCapacity) {
      // Dropping an audio packet would create a silent hole that is difficult
      // to diagnose. Stop accepting immediately and let the worker preserve
      // the packets already queued before finalizing an error recording.
      setError(LVErrorQueueFull);
      finishRequested_.store(true);
      os_unfair_lock_unlock(&queueLock_);
      condition_.notify_one();
      return false;
    }
    LVAudioPacket &packet = queue_[queueWrite_];
    packet.source = source;
    packet.hostTime = hostTime == 0 ? LVNowHostTime() : hostTime;
    packet.sampleRate = sampleRate;
    packet.channels = static_cast<uint16_t>(channels);
    packet.frames = static_cast<uint32_t>(frames);
    packet.muted = source == LVRecordingSourceMicrophone && muted_.load();
    memcpy(packet.samples, samples, frames * channels * sizeof(int16_t));
    queueWrite_ = (queueWrite_ + 1) % kPacketQueueCapacity;
    ++queueCount_;
    os_unfair_lock_unlock(&queueLock_);
    condition_.notify_one();
    return true;
  }

  void requestFinish(bool confirmedClose) {
    accepting_.store(false);
    bool expected = false;
    if (finishRequested_.compare_exchange_strong(expected, true)) {
      confirmedClose_.store(confirmedClose);
    }
    condition_.notify_one();
  }

  bool waitForFinish() {
    std::unique_lock<std::mutex> lock(doneMutex_);
    if (!doneCondition_.wait_for(lock, std::chrono::seconds(12),
                                 [this] { return done_; })) {
      setError(LVErrorFinishTimeout);
      return false;
    }
    return completed_;
  }

  void discard() {
    discarded_.store(true);
    accepting_.store(false);
    os_unfair_lock_lock(&queueLock_);
    queueCount_ = 0;
    queueRead_ = queueWrite_;
    os_unfair_lock_unlock(&queueLock_);
    condition_.notify_one();
    {
      std::unique_lock<std::mutex> lock(doneMutex_);
      doneCondition_.wait_for(lock, std::chrono::seconds(12),
                              [this] { return done_; });
    }
    removePartialFiles();
  }

  LVErrorIndex errorIndex() const {
    return static_cast<LVErrorIndex>(errorIndex_.load());
  }
  bool isSaving() const { return saving_.load(); }
  int64_t renderedFrames() const { return renderedFrames_; }
  int64_t sizeBytes() const { return sizeBytes_; }
  bool confirmedClose() const { return confirmedClose_.load(); }
  bool completed() const { return completed_; }

 private:
  bool pop(LVAudioPacket *packet) {
    os_unfair_lock_lock(&queueLock_);
    if (queueCount_ == 0) {
      os_unfair_lock_unlock(&queueLock_);
      return false;
    }
    *packet = queue_[queueRead_];
    queueRead_ = (queueRead_ + 1) % kPacketQueueCapacity;
    --queueCount_;
    os_unfair_lock_unlock(&queueLock_);
    return true;
  }

  void run();
  void process(const LVAudioPacket &packet);
  void flushSources();
  bool startWriter();
  void renderUntil(int64_t untilFrame, bool force);
  void closeWriter();
  bool finalizeAudio();
  bool writeMetadata();
  void removePartialFiles();

  void setError(LVErrorIndex value) {
    int expected = LVErrorNone;
    errorIndex_.compare_exchange_strong(expected, static_cast<int>(value));
    if (value == LVErrorStorageFull || value == LVErrorEncoderFailed ||
        value == LVErrorWriteFailed || value == LVErrorQueueFull) {
      accepting_.store(false);
    }
  }

  void complete(bool value) {
    {
      std::lock_guard<std::mutex> lock(doneMutex_);
      completed_ = value;
      done_ = true;
    }
    doneCondition_.notify_all();
  }

  std::string identifier_;
  std::string mode_;
  uint64_t startedAt_ = 0;
  std::string directory_;
  std::string finalPath_;
  std::string partialPath_;
  std::string metadataPath_;

  std::array<LVAudioPacket, kPacketQueueCapacity> queue_;
  os_unfair_lock queueLock_ = OS_UNFAIR_LOCK_INIT;
  size_t queueRead_ = 0;
  size_t queueWrite_ = 0;
  size_t queueCount_ = 0;
  std::mutex waitMutex_;
  std::condition_variable condition_;

  std::atomic<bool> accepting_{true};
  std::atomic<bool> connected_{false};
  std::atomic<bool> muted_{false};
  std::atomic<bool> finishRequested_{false};
  std::atomic<bool> discarded_{false};
  std::atomic<bool> confirmedClose_{false};
  std::atomic<bool> saving_{false};
  std::atomic<int> errorIndex_{LVErrorNone};

  std::mutex doneMutex_;
  std::condition_variable doneCondition_;
  bool done_ = false;
  bool completed_ = false;

  std::thread worker_;
  ExtAudioFileRef writer_ = nullptr;
  LVTimeline timelines_[2];
  LVSourceState sources_[2];
  uint64_t originHostTime_ = 0;
  int64_t latestEndFrame_ = 0;
  int64_t nextFrame_ = 0;
  int64_t renderedFrames_ = 0;
  int64_t sizeBytes_ = 0;
};

void LVSessionState::run() {
  LVAudioPacket packet;
  while (true) {
    if (pop(&packet)) {
      @autoreleasepool {
        process(packet);
      }
      continue;
    }
    if (discarded_.load()) {
      complete(false);
      return;
    }
    if (finishRequested_.load()) break;
    std::unique_lock<std::mutex> lock(waitMutex_);
    condition_.wait_for(lock, std::chrono::milliseconds(50));
  }
  if (discarded_.load()) {
    complete(false);
    return;
  }
  saving_.store(true);
  if (errorIndex() == LVErrorNone || errorIndex() == LVErrorQueueFull) {
    flushSources();
  }
  if (originHostTime_ != 0 && latestEndFrame_ > nextFrame_) {
    renderUntil(latestEndFrame_, true);
  }
  closeWriter();
  // Keep a usable partial recording when a bounded queue, storage or encoder
  // error happened after at least one AAC frame was written. The metadata
  // carries the fixed error code so the UI can explain the incomplete tail.
  if (renderedFrames_ > 0 && finalizeAudio()) {
    if (writeMetadata()) {
      completed_ = true;
    } else {
      setError(LVErrorStorageFailed);
    }
  } else if (errorIndex() == LVErrorNone) {
    setError(LVErrorNoAudio);
  }
  saving_.store(false);
  complete(completed_);
}

void LVSessionState::process(const LVAudioPacket &packet) {
  const LVErrorIndex currentError = errorIndex();
  if (discarded_.load() || packet.frames == 0 ||
      (currentError != LVErrorNone && currentError != LVErrorQueueFull)) {
    return;
  }
  if (originHostTime_ == 0) originHostTime_ = packet.hostTime;
  const size_t sourceIndex =
      packet.source == LVRecordingSourceAssistant ? 1 : 0;
  LVSourceState &source = sources_[sourceIndex];
  const bool firstPacket = !source.seen;
  bool substantialGap = false;
  if (!firstPacket && source.lastSampleRate > 0.0 &&
      source.lastHostTime > 0 && packet.hostTime > source.lastHostTime) {
    const uint64_t expectedEnd = source.lastHostTime +
        static_cast<uint64_t>(static_cast<double>(source.lastInputFrames) *
                              LVHostTimeFrequency() / source.lastSampleRate);
    const uint64_t gapThreshold = static_cast<uint64_t>(
        LVHostTimeFrequency() * 0.250);
    substantialGap = packet.hostTime > expectedEnd &&
                     packet.hostTime - expectedEnd > gapThreshold;
  }
  const bool rateChanged = source.seen &&
      fabs(source.lastSampleRate - packet.sampleRate) >= 0.5;
  if (firstPacket || substantialGap || !source.resampler.initialized() ||
      rateChanged) {
    source.resampler.reset(packet.sampleRate);
  }
  if (firstPacket || substantialGap || !source.hasOutputAnchor) {
    source.nextOutputFrame = LVRelativeFrames(packet.hostTime, originHostTime_);
    source.hasOutputAnchor = true;
  }
  std::vector<float> samples = LVMixDown(packet);
  std::vector<float> resampled = source.resampler.append(samples, false);
  source.seen = true;
  source.lastHostTime = packet.hostTime;
  source.lastInputFrames = packet.frames;
  source.lastSampleRate = packet.sampleRate;
  LVTimeline &timeline = timelines_[sourceIndex];
  timeline.append(source.nextOutputFrame, resampled);
  source.nextOutputFrame += static_cast<int64_t>(resampled.size());
  latestEndFrame_ = std::max(latestEndFrame_, timeline.endFrame());
  if (writer_ == nullptr && !startWriter()) return;

  const int64_t wallFrame = LVRelativeFrames(LVNowHostTime(), originHostTime_);
  const int64_t holdEnd = std::min(latestEndFrame_, wallFrame) - kRenderHoldFrames;
  if (holdEnd > nextFrame_) renderUntil(holdEnd, false);
}

void LVSessionState::flushSources() {
  for (size_t index = 0; index < 2; ++index) {
    LVSourceState &source = sources_[index];
    if (!source.seen || !source.resampler.initialized()) continue;
    std::vector<float> tail = source.resampler.append({}, true);
    if (tail.empty()) continue;
    timelines_[index].append(source.nextOutputFrame, tail);
    source.nextOutputFrame += static_cast<int64_t>(tail.size());
    latestEndFrame_ = std::max(latestEndFrame_, timelines_[index].endFrame());
  }
}

bool LVSessionState::startWriter() {
  NSString *directory = [NSString stringWithUTF8String:directory_.c_str()];
  if (!LVHasEnoughSpace(directory)) {
    setError(LVErrorStorageFull);
    return false;
  }
  NSString *partial = [NSString stringWithUTF8String:partialPath_.c_str()];
  [[NSFileManager defaultManager] removeItemAtPath:partial error:nil];

  AudioStreamBasicDescription output = {};
  output.mSampleRate = kOutputSampleRate;
  output.mFormatID = kAudioFormatMPEG4AAC;
  output.mChannelsPerFrame = 1;
  CFURLRef url = (__bridge CFURLRef)[NSURL fileURLWithPath:partial];
  OSStatus status = ExtAudioFileCreateWithURL(url, kAudioFileM4AType, &output,
                                               nullptr, kAudioFileFlags_EraseFile,
                                               &writer_);
  if (status != noErr || writer_ == nullptr) {
    writer_ = nullptr;
    setError(LVErrorEncoderFailed);
    return false;
  }

  AudioStreamBasicDescription client = {};
  client.mSampleRate = kOutputSampleRate;
  client.mFormatID = kAudioFormatLinearPCM;
  client.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
  client.mBytesPerPacket = sizeof(int16_t);
  client.mFramesPerPacket = 1;
  client.mBytesPerFrame = sizeof(int16_t);
  client.mChannelsPerFrame = 1;
  client.mBitsPerChannel = 16;
  status = ExtAudioFileSetProperty(writer_, kExtAudioFileProperty_ClientDataFormat,
                                    sizeof(client), &client);
  if (status != noErr) {
    closeWriter();
    setError(LVErrorEncoderFailed);
    return false;
  }
  AudioConverterRef converter = nullptr;
  UInt32 converterSize = sizeof(converter);
  if (ExtAudioFileGetProperty(writer_, kExtAudioFileProperty_AudioConverter,
                              &converterSize, &converter) == noErr &&
      converter != nullptr) {
    UInt32 bitRate = 64000;
    AudioConverterSetProperty(converter, kAudioConverterEncodeBitRate,
                               sizeof(bitRate), &bitRate);
  }
  return true;
}

void LVSessionState::renderUntil(int64_t untilFrame, bool force) {
  if (writer_ == nullptr || untilFrame <= nextFrame_) return;
  while (nextFrame_ < untilFrame) {
    if (!force &&
        nextFrame_ + static_cast<int64_t>(kOutputFrameSamples) > untilFrame) {
      break;
    }
    if (!LVHasEnoughSpace([NSString stringWithUTF8String:directory_.c_str()])) {
      setError(LVErrorStorageFull);
      return;
    }
    int16_t pcm[kOutputFrameSamples] = {};
    for (size_t index = 0; index < kOutputFrameSamples; ++index) {
      const int64_t frame = nextFrame_ + static_cast<int64_t>(index);
      const float mixed =
          (timelines_[0].sampleAt(frame) + timelines_[1].sampleAt(frame)) * 0.5f;
      pcm[index] = static_cast<int16_t>(
          std::clamp(mixed * 32767.0f, -32768.0f, 32767.0f));
    }
    AudioBufferList list = {};
    list.mNumberBuffers = 1;
    list.mBuffers[0].mNumberChannels = 1;
    list.mBuffers[0].mDataByteSize = sizeof(pcm);
    list.mBuffers[0].mData = pcm;
    OSStatus status = ExtAudioFileWrite(writer_, kOutputFrameSamples, &list);
    if (status != noErr) {
      setError(LVErrorEncoderFailed);
      return;
    }
    renderedFrames_ += static_cast<int64_t>(kOutputFrameSamples);
    nextFrame_ += static_cast<int64_t>(kOutputFrameSamples);
    timelines_[0].trimBefore(nextFrame_);
    timelines_[1].trimBefore(nextFrame_);
  }
}

void LVSessionState::closeWriter() {
  if (writer_ == nullptr) return;
  OSStatus status = ExtAudioFileDispose(writer_);
  writer_ = nullptr;
  if (status != noErr && errorIndex() == LVErrorNone) {
    setError(LVErrorEncoderFailed);
  }
}

bool LVSessionState::finalizeAudio() {
  NSString *partial = [NSString stringWithUTF8String:partialPath_.c_str()];
  NSString *final = [NSString stringWithUTF8String:finalPath_.c_str()];
  if ([[NSFileManager defaultManager] fileExistsAtPath:final]) {
    setError(LVErrorIdExists);
    return false;
  }
  NSError *moveError = nil;
  if (![[NSFileManager defaultManager] moveItemAtPath:partial
                                                toPath:final
                                                 error:&moveError]) {
    setError(LVErrorWriteFailed);
    return false;
  }
  NSDictionary *attributes =
      [[NSFileManager defaultManager] attributesOfItemAtPath:final error:nil];
  sizeBytes_ = [attributes[NSFileSize] longLongValue];
  if (sizeBytes_ <= 0) {
    [[NSFileManager defaultManager] removeItemAtPath:final error:nil];
    setError(LVErrorNoAudio);
    return false;
  }
  LVApplyFileAttributes(final);
  return true;
}

bool LVSessionState::writeMetadata() {
  NSString *identifier = [NSString stringWithUTF8String:identifier_.c_str()];
  NSString *mode = [NSString stringWithUTF8String:mode_.c_str()];
  NSDictionary *info = @{
    @"id" : identifier,
    @"mode" : mode,
    @"startedAt" : @(startedAt_),
    @"durationMs" : @(static_cast<int64_t>(
        llround(static_cast<double>(renderedFrames_) * 1000.0 / kOutputSampleRate))),
    @"sizeBytes" : @(sizeBytes_),
    @"confirmedClose" : @(confirmedClose_.load()),
  };
  NSString *errorCode = LVErrorString(errorIndex());
  if (errorCode != nil) {
    NSMutableDictionary *withError = [info mutableCopy];
    withError[@"errorCode"] = errorCode;
    info = withError;
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:info options:0 error:nil];
  if (data == nil) return false;
  NSString *metadata = [NSString stringWithUTF8String:metadataPath_.c_str()];
  if (![data writeToFile:metadata options:NSDataWritingAtomic error:nil]) return false;
  LVApplyFileAttributes(metadata);
  return true;
}

void LVSessionState::removePartialFiles() {
  NSString *partial = [NSString stringWithUTF8String:partialPath_.c_str()];
  [[NSFileManager defaultManager] removeItemAtPath:partial error:nil];
  NSString *metadataPart = [NSString stringWithFormat:@"%s.part", metadataPath_.c_str()];
  [[NSFileManager defaultManager] removeItemAtPath:metadataPart error:nil];
}

static NSDictionary *LVReadInfo(NSString *directory, NSString *identifier) {
  if (!LVValidIdentifier(identifier)) return nil;
  NSString *audio =
      [directory stringByAppendingPathComponent:[identifier stringByAppendingPathExtension:@"m4a"]];
  NSString *metadata =
      [directory stringByAppendingPathComponent:[identifier stringByAppendingPathExtension:@"json"]];
  NSData *data = [NSData dataWithContentsOfFile:metadata];
  if (data == nil || data.length == 0) return nil;
  NSDictionary *json =
      [NSJSONSerialization JSONObjectWithData:data
                                      options:0
                                        error:nil];
  if (![json isKindOfClass:[NSDictionary class]]) return nil;
  NSString *storedID = json[@"id"];
  NSString *mode = json[@"mode"];
  NSNumber *startedAt = json[@"startedAt"];
  NSNumber *duration = json[@"durationMs"];
  NSNumber *size = json[@"sizeBytes"];
  NSNumber *confirmed = json[@"confirmedClose"];
  if (![storedID isEqualToString:identifier] || !LVValidMode(mode) ||
      ![startedAt isKindOfClass:[NSNumber class]] ||
      ![duration isKindOfClass:[NSNumber class]] ||
      ![size isKindOfClass:[NSNumber class]] ||
      ![confirmed isKindOfClass:[NSNumber class]] ||
      startedAt.longLongValue < 0 ||
      duration.longLongValue <= 0 ||
      size.longLongValue <= 0 ||
      ![[NSFileManager defaultManager] fileExistsAtPath:audio]) {
    return nil;
  }
  NSMutableDictionary *result = [@{
    @"id" : identifier,
    @"mode" : mode,
    @"startedAt" : startedAt,
    @"durationMs" : duration,
    @"sizeBytes" : size,
    @"confirmedClose" : confirmed,
  } mutableCopy];
  NSString *errorCode = json[@"errorCode"];
  NSArray<NSString *> *allowed = @[
    @"recording_storage_full", @"recording_storage_failed",
    @"recording_encoder_failed", @"recording_write_failed",
    @"recording_finish_timeout", @"recording_no_audio",
    @"recording_id_exists", @"recording_interrupted",
    @"recording_queue_full"
  ];
  if ([errorCode isKindOfClass:[NSString class]] &&
      [allowed containsObject:errorCode]) {
    result[@"errorCode"] = errorCode;
  }
  return result;
}

static NSDictionary *LVInfoForState(const std::shared_ptr<LVSessionState> &state) {
  if (!state || !state->completed()) return nil;
  NSMutableDictionary *result = [@{
    @"id" : [NSString stringWithUTF8String:state->identifier().c_str()],
    @"mode" : [NSString stringWithUTF8String:state->mode().c_str()],
    @"startedAt" : @(state->startedAt()),
    @"durationMs" : @(static_cast<int64_t>(
        llround(static_cast<double>(state->renderedFrames()) * 1000.0 /
                kOutputSampleRate))),
    @"sizeBytes" : @(state->sizeBytes()),
    @"confirmedClose" : @(state->confirmedClose()),
  } mutableCopy];
  NSString *errorCode = LVErrorString(state->errorIndex());
  if (errorCode != nil) result[@"errorCode"] = errorCode;
  return result;
}

}  // namespace

@interface LVRecordingEngine () {
  std::mutex _stateMutex;
  std::shared_ptr<LVSessionState> _active;
  NSString *_lastFinishedID;
  NSDictionary *_lastFinishedInfo;
  NSString *_directory;
}
@end

@implementation LVRecordingEngine

+ (instancetype)sharedEngine {
  static LVRecordingEngine *engine;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{ engine = [[self alloc] init]; });
  return engine;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _directory = LVRecordingDirectory();
  }
  return self;
}

- (instancetype)initForTestingWithDirectory:(NSString *)directory {
  self = [super init];
  if (self) {
    _directory = [directory copy];
    [[NSFileManager defaultManager] createDirectoryAtPath:_directory
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
  }
  return self;
}

- (BOOL)startSession:(NSString *)identifier
                mode:(NSString *)mode
           startedAt:(double)startedAt
          errorCode:(NSString * _Nullable * _Nullable)errorCode {
  if (!LVValidIdentifier(identifier) || !LVValidMode(mode)) {
    LVSetError(errorCode, @"recording_invalid_id");
    return NO;
  }
  std::lock_guard<std::mutex> lock(_stateMutex);
  if (_active) {
    LVSetError(errorCode, @"recording_busy");
    return NO;
  }
  NSString *finalPath =
      [_directory stringByAppendingPathComponent:[identifier stringByAppendingPathExtension:@"m4a"]];
  if ([[NSFileManager defaultManager] fileExistsAtPath:finalPath]) {
    LVSetError(errorCode, @"recording_id_exists");
    return NO;
  }
  [[NSFileManager defaultManager]
      removeItemAtPath:[_directory stringByAppendingPathComponent:
                         [identifier stringByAppendingPathExtension:@"m4a.part"]]
                 error:nil];
  [[NSFileManager defaultManager]
      removeItemAtPath:[_directory stringByAppendingPathComponent:
                         [identifier stringByAppendingPathExtension:@"json.part"]]
                 error:nil];
  _active = std::make_shared<LVSessionState>(
      identifier.UTF8String, mode.UTF8String,
      static_cast<uint64_t>(std::max(0.0, startedAt)), _directory.UTF8String);
  LVSetError(errorCode, nil);
  return YES;
}

- (BOOL)markSessionConnected:(NSString *)identifier
                   errorCode:(NSString * _Nullable * _Nullable)errorCode {
  std::shared_ptr<LVSessionState> state;
  {
    std::lock_guard<std::mutex> lock(_stateMutex);
    state = _active;
  }
  if (!state ||
      ![identifier isEqualToString:
          [NSString stringWithUTF8String:state->identifier().c_str()]]) {
    LVSetError(errorCode, @"recording_not_found");
    return NO;
  }
  if (!state->markConnected()) {
    LVSetError(errorCode, @"recording_not_ready");
    return NO;
  }
  LVSetError(errorCode, nil);
  return YES;
}

- (BOOL)offerPCM16:(const int16_t *)samples
            frames:(size_t)frames
        sampleRate:(double)sampleRate
          channels:(size_t)channels
          hostTime:(uint64_t)hostTime
            source:(LVRecordingSource)source {
  std::shared_ptr<LVSessionState> state;
  {
    std::lock_guard<std::mutex> lock(_stateMutex);
    state = _active;
  }
  if (!state || frames == 0 || samples == nullptr) return NO;
  size_t offset = 0;
  bool accepted = false;
  while (offset < frames) {
    const size_t count = std::min(kMaxPacketFrames, frames - offset);
    const int16_t *chunk = samples + offset * channels;
    const uint64_t chunkHostTime = hostTime == 0
        ? 0
        : hostTime + static_cast<uint64_t>(
              static_cast<double>(offset) * LVHostTimeFrequency() / sampleRate);
    accepted = state->offer(chunk, count, sampleRate, channels, chunkHostTime,
                            source) || accepted;
    offset += count;
  }
  return accepted;
}

- (nullable NSDictionary *)finishSession:(NSString *)identifier
                          confirmedClose:(BOOL)confirmedClose
                               errorCode:(NSString * _Nullable * _Nullable)errorCode {
  std::shared_ptr<LVSessionState> state;
  {
    std::lock_guard<std::mutex> lock(_stateMutex);
    if (_lastFinishedID != nil &&
        [_lastFinishedID isEqualToString:identifier] &&
        _lastFinishedInfo != nil) {
      LVSetError(errorCode, nil);
      return _lastFinishedInfo;
    }
    state = _active;
    if (!state ||
        ![identifier isEqualToString:
            [NSString stringWithUTF8String:state->identifier().c_str()]]) {
      LVSetError(errorCode, @"recording_not_found");
      return nil;
    }
    _active.reset();
  }
  state->requestFinish(confirmedClose);
  if (!state->waitForFinish()) {
    LVSetError(errorCode, LVErrorString(state->errorIndex()) ?:
        @"recording_finish_failed");
    return nil;
  }
  NSDictionary *result = LVInfoForState(state);
  if (result == nil) {
    LVSetError(errorCode, LVErrorString(state->errorIndex()) ?:
        @"recording_finish_failed");
    return nil;
  }
  {
    std::lock_guard<std::mutex> lock(_stateMutex);
    _lastFinishedID = [identifier copy];
    _lastFinishedInfo = [result copy];
  }
  LVSetError(errorCode, nil);
  return result;
}

- (BOOL)discardSession:(NSString *)identifier
             errorCode:(NSString * _Nullable * _Nullable)errorCode {
  std::shared_ptr<LVSessionState> state;
  {
    std::lock_guard<std::mutex> lock(_stateMutex);
    state = _active;
    if (!state ||
        ![identifier isEqualToString:
            [NSString stringWithUTF8String:state->identifier().c_str()]]) {
      LVSetError(errorCode, @"recording_not_found");
      return NO;
    }
    _active.reset();
  }
  state->discard();
  LVSetError(errorCode, nil);
  return YES;
}

- (BOOL)setSessionMuted:(NSString *)identifier
                  muted:(BOOL)muted
              errorCode:(NSString * _Nullable * _Nullable)errorCode {
  std::shared_ptr<LVSessionState> state;
  {
    std::lock_guard<std::mutex> lock(_stateMutex);
    state = _active;
  }
  if (!state ||
      ![identifier isEqualToString:
          [NSString stringWithUTF8String:state->identifier().c_str()]]) {
    LVSetError(errorCode, @"recording_not_found");
    return NO;
  }
  state->setMuted(muted);
  LVSetError(errorCode, nil);
  return YES;
}

- (NSDictionary *)statusSnapshot {
  std::shared_ptr<LVSessionState> state;
  {
    std::lock_guard<std::mutex> lock(_stateMutex);
    state = _active;
  }
  if (!state) return @{@"state" : @"idle"};
  NSString *stateName = state->isSaving()
      ? @"saving"
      : (state->errorIndex() != LVErrorNone ? @"error" : @"recording");
  NSMutableDictionary *result = [@{
    @"id" : [NSString stringWithUTF8String:state->identifier().c_str()],
    @"state" : stateName,
  } mutableCopy];
  NSString *error = LVErrorString(state->errorIndex());
  if (error != nil) result[@"code"] = error;
  return result;
}

- (NSDictionary *)listOffset:(NSUInteger)offset limit:(NSUInteger)limit {
  limit = std::min<NSUInteger>(limit == 0 ? 50 : limit, 50);
  NSMutableArray<NSDictionary *> *all = [NSMutableArray array];
  NSArray<NSString *> *files =
      [[NSFileManager defaultManager] contentsOfDirectoryAtPath:_directory error:nil];
  for (NSString *file in files) {
    if (![file.pathExtension isEqualToString:@"json"]) continue;
    NSDictionary *info = LVReadInfo(_directory, [file stringByDeletingPathExtension]);
    if (info != nil) [all addObject:info];
  }
  [all sortUsingComparator:^NSComparisonResult(NSDictionary *left,
                                                NSDictionary *right) {
    NSNumber *a = left[@"startedAt"];
    NSNumber *b = right[@"startedAt"];
    if (a.unsignedLongLongValue != b.unsignedLongLongValue) {
      return a.unsignedLongLongValue > b.unsignedLongLongValue
          ? NSOrderedAscending
          : NSOrderedDescending;
    }
    return [left[@"id"] compare:right[@"id"]];
  }];
  NSUInteger begin = std::min(offset, all.count);
  NSUInteger end = std::min(begin + limit, all.count);
  return @{
    @"items" : [all subarrayWithRange:NSMakeRange(begin, end - begin)],
    @"hasMore" : @(end < all.count),
  };
}

- (nullable NSDictionary *)infoForIdentifier:(NSString *)identifier {
  return LVReadInfo(_directory, identifier);
}

- (BOOL)deleteIdentifier:(NSString *)identifier
               errorCode:(NSString * _Nullable * _Nullable)errorCode {
  if (!LVValidIdentifier(identifier)) {
    LVSetError(errorCode, @"recording_invalid_id");
    return NO;
  }
  std::shared_ptr<LVSessionState> active;
  {
    std::lock_guard<std::mutex> lock(_stateMutex);
    active = _active;
  }
  if (active &&
      [identifier isEqualToString:
          [NSString stringWithUTF8String:active->identifier().c_str()]]) {
    LVSetError(errorCode, @"recording_busy");
    return NO;
  }
  NSString *audio =
      [_directory stringByAppendingPathComponent:[identifier stringByAppendingPathExtension:@"m4a"]];
  NSString *metadata =
      [_directory stringByAppendingPathComponent:[identifier stringByAppendingPathExtension:@"json"]];
  NSError *error = nil;
  BOOL removed = NO;
  if ([[NSFileManager defaultManager] fileExistsAtPath:audio]) {
    removed = [[NSFileManager defaultManager] removeItemAtPath:audio error:&error] || removed;
  }
  if ([[NSFileManager defaultManager] fileExistsAtPath:metadata]) {
    removed = [[NSFileManager defaultManager] removeItemAtPath:metadata error:&error] || removed;
  }
  if (!removed) {
    LVSetError(errorCode, @"recording_not_found");
    return NO;
  }
  {
    std::lock_guard<std::mutex> lock(_stateMutex);
    if ([_lastFinishedID isEqualToString:identifier]) {
      _lastFinishedID = nil;
      _lastFinishedInfo = nil;
    }
  }
  LVSetError(errorCode, nil);
  return YES;
}

- (nullable NSURL *)fileURLForIdentifier:(NSString *)identifier {
  if (!LVValidIdentifier(identifier)) return nil;
  NSString *audio =
      [_directory stringByAppendingPathComponent:[identifier stringByAppendingPathExtension:@"m4a"]];
  if (![[NSFileManager defaultManager] fileExistsAtPath:audio]) return nil;
  return [NSURL fileURLWithPath:audio];
}

- (void)finishActiveSessionUnconfirmed {
  std::shared_ptr<LVSessionState> state;
  {
    std::lock_guard<std::mutex> lock(_stateMutex);
    state = _active;
    if (state) _active.reset();
  }
  if (state != nullptr) {
    state->requestFinish(NO);
    if (state->waitForFinish()) {
      NSDictionary *result = LVInfoForState(state);
      if (result != nil) {
        std::lock_guard<std::mutex> lock(_stateMutex);
        _lastFinishedID =
            [NSString stringWithUTF8String:state->identifier().c_str()];
        _lastFinishedInfo = [result copy];
      }
    }
  }
}

@end
