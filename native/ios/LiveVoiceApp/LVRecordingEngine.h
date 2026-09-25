#import <Foundation/Foundation.h>

#include <stddef.h>
#include <stdint.h>

NS_ASSUME_NONNULL_BEGIN

/** The two PCM streams that make up a local conversation recording. */
typedef NS_ENUM(NSInteger, LVRecordingSource) {
  LVRecordingSourceMicrophone = 0,
  LVRecordingSourceAssistant = 1,
};

/**
 * App-local recording store and PCM mixer.
 *
 * The audio-device callbacks use offerPCM16:... directly.  It copies into a
 * bounded native queue and returns immediately; encoding, resampling and file
 * I/O happen on the session worker thread.  The class deliberately exposes
 * no decrypted configuration, transcript, or audio path to logs.
 */
@interface LVRecordingEngine : NSObject

+ (instancetype)sharedEngine;

/** Test-only initializer; production uses the app-private directory above. */
- (instancetype)initForTestingWithDirectory:(NSString *)directory;

- (BOOL)startSession:(NSString *)identifier
                mode:(NSString *)mode
           startedAt:(double)startedAt
          errorCode:(NSString * _Nullable * _Nullable)errorCode;

- (BOOL)markSessionConnected:(NSString *)identifier
                   errorCode:(NSString * _Nullable * _Nullable)errorCode;

/**
 * Called from the realtime audio callbacks.  samples is signed, little
 * endian, interleaved PCM16. hostTime is AudioTimeStamp.mHostTime.
 */
- (BOOL)offerPCM16:(const int16_t *)samples
            frames:(size_t)frames
        sampleRate:(double)sampleRate
          channels:(size_t)channels
          hostTime:(uint64_t)hostTime
            source:(LVRecordingSource)source;

- (nullable NSDictionary *)finishSession:(NSString *)identifier
                          confirmedClose:(BOOL)confirmedClose
                               errorCode:(NSString * _Nullable * _Nullable)errorCode;

- (BOOL)discardSession:(NSString *)identifier
             errorCode:(NSString * _Nullable * _Nullable)errorCode;

- (BOOL)setSessionMuted:(NSString *)identifier
                  muted:(BOOL)muted
              errorCode:(NSString * _Nullable * _Nullable)errorCode;

- (NSDictionary *)statusSnapshot;

- (NSDictionary *)listOffset:(NSUInteger)offset
                        limit:(NSUInteger)limit;

- (nullable NSDictionary *)infoForIdentifier:(NSString *)identifier;

- (BOOL)deleteIdentifier:(NSString *)identifier
               errorCode:(NSString * _Nullable * _Nullable)errorCode;

/** Returns a validated local file URL for the playback bridge. */
- (nullable NSURL *)fileURLForIdentifier:(NSString *)identifier;

/** Best-effort cleanup used when the React Native context is invalidated. */
- (void)finishActiveSessionUnconfirmed;

@end

NS_ASSUME_NONNULL_END
