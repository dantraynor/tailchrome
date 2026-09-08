#define TAILCHROME_LAUNCHER_TEST
#import "per-user-launcher.m"
#include <assert.h>

static void writeHelper(NSURL *url, NSString *script, NSNumber *mode) {
    [[NSFileManager defaultManager] removeItemAtURL:url error:NULL];
    assert([[NSFileManager defaultManager] createFileAtPath:url.path
        contents:[script dataUsingEncoding:NSUTF8StringEncoding]
        attributes:@{NSFilePosixPermissions: mode}]);
}

int main(void) {
    @autoreleasepool {
        NSFileManager *fm = [NSFileManager defaultManager];
        NSURL *root = [NSURL fileURLWithPath:[NSTemporaryDirectory()
            stringByAppendingPathComponent:[NSUUID UUID].UUIDString]];
        NSURL *bundle = [root URLByAppendingPathComponent:@"A user's Downloads/Tailchrome Helper.app"];
        NSURL *macOS = [bundle URLByAppendingPathComponent:@"Contents/MacOS"];
        assert([fm createDirectoryAtURL:macOS withIntermediateDirectories:YES attributes:nil error:NULL]);
        NSURL *helper = [macOS URLByAppendingPathComponent:@"tailscale-browser-ext"];
        NSError *error = nil;

        assert(!installHelper(bundle, &error));
        assert(error != nil);

        writeHelper(helper, @"#!/bin/bash\n[[ $# == 1 && $1 == -install-now ]] || exit 9\n! read -r line\n", @0755);
        assert(installHelper(bundle, NULL));

        writeHelper(helper, @"#!/bin/bash\nexit 7\n", @0755);
        assert(!installHelper(bundle, NULL));

        writeHelper(helper, @"#!/bin/bash\nexit 0\n", @0644);
        assert(!installHelper(bundle, NULL));
        assert([fm removeItemAtURL:root error:NULL]);
        puts("Per-user launcher tests passed.");
    }
    return 0;
}
