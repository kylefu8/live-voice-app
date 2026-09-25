#import <React/RCTHTTPRequestHandler.h>

// Keep direct-service credentials on the configured endpoint. RN's default
// iOS handler follows redirects; this app deliberately returns the 3xx instead.
@interface LVHTTPRequestHandler : RCTHTTPRequestHandler <NSURLSessionTaskDelegate>
@end

@implementation LVHTTPRequestHandler
RCT_EXPORT_MODULE()

- (float)handlerPriority { return 10; }

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
 willPerformHTTPRedirection:(NSHTTPURLResponse *)response
        newRequest:(NSURLRequest *)request
 completionHandler:(void (^)(NSURLRequest *))completionHandler
{
  completionHandler(nil);
}
@end
