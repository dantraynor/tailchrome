#import <Cocoa/Cocoa.h>

static BOOL installHelper(NSURL *bundleURL, NSError **error) {
    NSURL *helperURL = [bundleURL URLByAppendingPathComponent:@"Contents/MacOS/tailscale-browser-ext"];
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = helperURL;
    task.arguments = @[@"-install-now"];
    task.standardInput = [NSFileHandle fileHandleWithNullDevice];
    if (![task launchAndReturnError:error]) {
        return NO;
    }
    [task waitUntilExit];
    return task.terminationReason == NSTaskTerminationReasonExit && task.terminationStatus == 0;
}

#ifndef TAILCHROME_LAUNCHER_TEST
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSError *error = nil;
        BOOL installed = installHelper([NSBundle mainBundle].bundleURL, &error);
        if (error) {
            NSLog(@"Helper setup failed: %@", error);
        }
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = installed ? @"Setup is complete" : @"Setup could not finish";
        alert.informativeText = installed
            ? @"Return to your browser and open Tailchrome."
            : @"Close your browsers and try again. If the app is incomplete, download Tailchrome Helper again from GitHub Releases.";
        alert.alertStyle = installed ? NSAlertStyleInformational : NSAlertStyleCritical;
        [alert addButtonWithTitle:@"OK"];
        [NSApp activateIgnoringOtherApps:YES];
        [alert runModal];
        return installed ? 0 : 1;
    }
}
#endif
