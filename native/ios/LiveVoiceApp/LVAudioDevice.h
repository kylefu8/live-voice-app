#import <Foundation/Foundation.h>

#import <WebRTC/RTCAudioDevice.h>

#include <stdint.h>

NS_ASSUME_NONNULL_BEGIN

/** Installs the app-owned VoiceProcessingIO device before the RN factory starts. */
FOUNDATION_EXPORT void LVInstallAudioDevice(void);
/** Opens the generation gate for a new live audio session. */
FOUNDATION_EXPORT void LVStartAudioDeviceSession(void);
/** Synchronously stops both directions before VoiceAudio restores AVAudioSession. */
FOUNDATION_EXPORT void LVStopAudioDevice(void);
/** Numeric counters only; never retains or exports audio samples. */
FOUNDATION_EXPORT NSDictionary *LVAudioDiagnosticSnapshot(void);
FOUNDATION_EXPORT NSString *const LVAudioDeviceFailedNotification;

@interface LVAudioDevice : NSObject <RTC_OBJC_TYPE(RTCAudioDevice)>
@end

NS_ASSUME_NONNULL_END
