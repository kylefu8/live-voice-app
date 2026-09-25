#import <React/RCTBridgeModule.h>

// The implementation lives in QrConfig.swift.  Keeping the Objective-C
// export declaration here lets React Native discover the Swift class without
// adding a third-party scanner or a second bridge layer.
@interface RCT_EXTERN_MODULE(QrConfig, NSObject)

RCT_EXTERN_METHOD(scan:(NSString *)locale
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(decrypt:(NSString *)payload
                  passphrase:(NSString *)passphrase
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancel:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
