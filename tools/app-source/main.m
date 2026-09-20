#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

static NSString *const kAppTitle = @"环形调制计算器";
static NSString *const kExternalHTML = @"Documents/ChatGPT/论文paper/tools/ringmod-demo.html";

/* 调试日志（排查用，写到 /tmp/ringmod-app.log） */
static void RMLog(NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *line = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    NSString *entry = [NSString stringWithFormat:@"%@ %@\n", [NSDate date], line];
    FILE *f = fopen("/tmp/ringmod-app.log", "a");
    if (f) { fputs(entry.UTF8String, f); fclose(f); }
}

@interface AppDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate>
@property (nonatomic, strong) NSWindow *window;
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, strong) NSURL *lastDownload;
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)note {
    [self buildMenu];

    NSRect rect = NSMakeRect(0, 0, 1080, 820);
    NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                              NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
    self.window = [[NSWindow alloc] initWithContentRect:rect styleMask:style
                                                backing:NSBackingStoreBuffered defer:NO];
    self.window.title = kAppTitle;
    self.window.minSize = NSMakeSize(780, 560);
    [self.window center];

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    self.webView = [[WKWebView alloc] initWithFrame:rect configuration:config];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.webView.navigationDelegate = self;
    self.webView.UIDelegate = self;
    self.window.contentView = self.webView;

    [self loadPage];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }

- (void)loadPage {
    NSString *external = [NSHomeDirectory() stringByAppendingPathComponent:kExternalHTML];
    if ([[NSFileManager defaultManager] fileExistsAtPath:external]) {
        NSURL *url = [NSURL fileURLWithPath:external];
        [self.webView loadFileURL:url allowingReadAccessToURL:[url URLByDeletingLastPathComponent]];
        return;
    }
    NSString *bundled = [[NSBundle mainBundle] pathForResource:@"ringmod-demo" ofType:@"html"];
    if (bundled) {
        NSURL *url = [NSURL fileURLWithPath:bundled];
        [self.webView loadFileURL:url allowingReadAccessToURL:[[NSBundle mainBundle] resourceURL]];
    }
}

- (void)reloadPage:(id)sender { [self.webView reload]; }

- (void)buildMenu {
    NSMenu *bar = [[NSMenu alloc] init];

    NSMenuItem *appItem = [[NSMenuItem alloc] init];
    [bar addItem:appItem];
    NSMenu *appMenu = [[NSMenu alloc] init];
    [appMenu addItemWithTitle:[@"关于 " stringByAppendingString:kAppTitle]
                       action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"隐藏" action:@selector(hide:) keyEquivalent:@"h"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:[@"退出 " stringByAppendingString:kAppTitle]
                       action:@selector(terminate:) keyEquivalent:@"q"];
    appItem.submenu = appMenu;

    NSMenuItem *viewItem = [[NSMenuItem alloc] init];
    [bar addItem:viewItem];
    NSMenu *viewMenu = [[NSMenu alloc] initWithTitle:@"显示"];
    [viewMenu addItemWithTitle:@"重新载入" action:@selector(reloadPage:) keyEquivalent:@"r"];
    [viewMenu addItem:[NSMenuItem separatorItem]];
    [viewMenu addItemWithTitle:@"放大" action:@selector(zoomIn:) keyEquivalent:@"+"];
    [viewMenu addItemWithTitle:@"缩小" action:@selector(zoomOut:) keyEquivalent:@"-"];
    [viewMenu addItemWithTitle:@"实际大小" action:@selector(zoomReset:) keyEquivalent:@"0"];
    viewItem.submenu = viewMenu;

    NSMenuItem *editItem = [[NSMenuItem alloc] init];
    [bar addItem:editItem];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"编辑"];
    [editMenu addItemWithTitle:@"拷贝" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"全选" action:@selector(selectAll:) keyEquivalent:@"a"];
    editItem.submenu = editMenu;

    [NSApp setMainMenu:bar];
}

/* ---------- 缩放 ---------- */
- (void)zoomIn:(id)sender   { self.webView.pageZoom = MIN(self.webView.pageZoom + 0.1, 2.5); }
- (void)zoomOut:(id)sender  { self.webView.pageZoom = MAX(self.webView.pageZoom - 0.1, 0.5); }
- (void)zoomReset:(id)sender { self.webView.pageZoom = 1.0; }

/* ---------- 链接跳转 / 下载 ---------- */
- (void)webView:(WKWebView *)webView
        decidePolicyForNavigationAction:(WKNavigationAction *)action
                        decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    BOOL wantsDownload = NO;
    if (@available(macOS 11.3, *)) { wantsDownload = action.shouldPerformDownload; }
    RMLog(@"nav action: %@ type=%ld download=%d", url.scheme, (long)action.navigationType, wantsDownload);
    /* 页面里的 <a download>（导出 SVG / PNG）要走下载通道 */
    if (@available(macOS 11.3, *)) {
        if (action.shouldPerformDownload) {
            decisionHandler(WKNavigationActionPolicyDownload);
            return;
        }
    }
    if (action.navigationType == WKNavigationTypeLinkActivated && ![url.scheme isEqualToString:@"file"]) {
        [[NSWorkspace sharedWorkspace] openURL:url];
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView *)webView
        decidePolicyForNavigationResponse:(WKNavigationResponse *)response
                          decisionHandler:(void (^)(WKNavigationResponsePolicy))decisionHandler {
    NSString *mime = response.response.MIMEType ?: @"";
    RMLog(@"nav response: mime=%@ canShow=%d", mime, (int)response.canShowMIMEType);
    if ([mime isEqualToString:@"image/svg+xml"] || [mime isEqualToString:@"image/png"]) {
        decisionHandler(WKNavigationResponsePolicyDownload);   // 导出的图直接存盘
        return;
    }
    if (response.canShowMIMEType) {
        decisionHandler(WKNavigationResponsePolicyAllow);
    } else {
        decisionHandler(WKNavigationResponsePolicyDownload);
    }
}

- (void)webView:(WKWebView *)webView
        navigationResponse:(WKNavigationResponse *)navigationResponse
        didBecomeDownload:(WKDownload *)download {
    download.delegate = self;
}

- (void)webView:(WKWebView *)webView
        navigationAction:(WKNavigationAction *)navigationAction
        didBecomeDownload:(WKDownload *)download {
    download.delegate = self;
}

- (void)download:(WKDownload *)download
        decideDestinationUsingResponse:(NSURLResponse *)response
                     suggestedFilename:(NSString *)suggestedFilename
                     completionHandler:(void (^)(NSURL * _Nullable))completionHandler {
    NSURL *dir = [NSURL fileURLWithPath:[NSHomeDirectory() stringByAppendingPathComponent:@"Downloads"]
                            isDirectory:YES];
    NSFileManager *fm = [NSFileManager defaultManager];
    NSURL *dest = [dir URLByAppendingPathComponent:suggestedFilename];
    NSString *base = [suggestedFilename stringByDeletingPathExtension];
    NSString *ext = [suggestedFilename pathExtension];
    int n = 2;
    while ([fm fileExistsAtPath:dest.path]) {          // 同名文件自动加序号
        dest = [dir URLByAppendingPathComponent:
                [NSString stringWithFormat:@"%@-%d.%@", base, n++, ext]];
    }
    RMLog(@"download destination -> %@", dest.path);
    self.lastDownload = dest;
    completionHandler(dest);
}

- (void)downloadDidFinish:(WKDownload *)download {
    RMLog(@"download finished");
    if (self.lastDownload) {
        [[NSWorkspace sharedWorkspace] activateFileViewerSelectingURLs:@[self.lastDownload]];
    }
}

- (void)download:(WKDownload *)download didFailWithError:(NSError *)error {
    RMLog(@"download failed: %@", error);
}

/* ---------- 页面里的 alert ---------- */
- (void)webView:(WKWebView *)webView
        runJavaScriptAlertPanelWithMessage:(NSString *)message
                          initiatedByFrame:(WKFrameInfo *)frame
                         completionHandler:(void (^)(void))completionHandler {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = message;
    [alert runModal];
    completionHandler();
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        app.delegate = delegate;
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        [app run];
    }
    return 0;
}
