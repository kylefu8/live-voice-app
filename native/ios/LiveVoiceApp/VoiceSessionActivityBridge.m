#import <React/RCTBridgeModule.h>

// ActivityKit is implemented in Swift.  This declaration keeps the bridge
// narrow and lets React Native discover the module without exposing any
// credentials, transcript text, or ActivityKit types to JavaScript.
@interface RCT_EXTERN_MODULE(VoiceSessionActivity, NSObject)

RCT_EXTERN_METHOD(start:(NSString *)identifier
                  locale:(NSString *)locale
                  state:(NSDictionary *)state
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(update:(NSString *)identifier
                  state:(NSDictionary *)state
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(end:(NSString *)identifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
