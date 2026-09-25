#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <Security/Security.h>

static NSString * const kSecureConnectionsError = @"storage_failed";
static NSString * const kSecureConnectionsService = @"com.livevoiceapp.connections.v2";
static NSString * const kSecureConnectionsAccount = @"credential";
static NSUInteger const kSecureConnectionsMaxBytes = 64 * 1024;

@interface SecureConnections : NSObject <RCTBridgeModule>
@end

@implementation SecureConnections

RCT_EXPORT_MODULE(SecureConnections)

+ (BOOL)requiresMainQueueSetup
{
  // Keychain calls are synchronous and this module has no UI. React Native
  // supplies its default serial method queue when this returns NO.
  return NO;
}

RCT_EXPORT_METHOD(setBundle:(NSString *)json
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  if (data == nil || data.length == 0 || data.length > kSecureConnectionsMaxBytes) {
    reject(kSecureConnectionsError, nil, nil);
    return;
  }

  NSError *parseError = nil;
  id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:&parseError];
  if (![object isKindOfClass:[NSDictionary class]]) {
    reject(kSecureConnectionsError, nil, nil);
    return;
  }

  NSDictionary *bundle = (NSDictionary *)object;
  id version = bundle[@"version"];
  id connections = bundle[@"connections"];
  // JS performs the complete credential validation. The native boundary only
  // checks the versioned bundle shape before touching the Keychain.
  if (![version isKindOfClass:[NSNumber class]] ||
      CFGetTypeID((__bridge CFTypeRef)version) == CFBooleanGetTypeID() ||
      [(NSNumber *)version doubleValue] != 2.0 ||
      ![connections isKindOfClass:[NSDictionary class]]) {
    reject(kSecureConnectionsError, nil, nil);
    return;
  }

  NSDictionary *query = @{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: kSecureConnectionsService,
    (__bridge id)kSecAttrAccount: kSecureConnectionsAccount,
  };
  NSDictionary *updatedAttributes = @{
    (__bridge id)kSecValueData: data,
    (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
  };

  OSStatus status = SecItemUpdate(
    (__bridge CFDictionaryRef)query,
    (__bridge CFDictionaryRef)updatedAttributes
  );

  if (status == errSecItemNotFound) {
    NSDictionary *item = @{
      (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService: kSecureConnectionsService,
      (__bridge id)kSecAttrAccount: kSecureConnectionsAccount,
      (__bridge id)kSecValueData: data,
      (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      (__bridge id)kSecAttrSynchronizable: @NO,
    };
    status = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
  }

  if (status != errSecSuccess) {
    reject(kSecureConnectionsError, nil, nil);
    return;
  }
  resolve(nil);
}

@end
