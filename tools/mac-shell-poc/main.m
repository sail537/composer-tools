#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <QuartzCore/QuartzCore.h>

static NSString * const kAppTitle = @"作曲工具 PoC";
static NSString * const kTransportFrameName = @"FloatingTransportPanel";

static void PoCLog(NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *line = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    NSString *entry = [NSString stringWithFormat:@"%@ %@\n", [NSDate date], line];
    FILE *file = fopen("/tmp/composer-poc.log", "a");
    if (file) { fputs(entry.UTF8String, file); fclose(file); }
}

static BOOL POCFlag(NSString *name) {
    return [[NSFileManager defaultManager] fileExistsAtPath:[@"/tmp/" stringByAppendingString:name]];
}

#pragma mark - 内容层渐变背景

@interface GradientView : NSView
@end

@implementation GradientView
- (void)drawRect:(NSRect)dirtyRect {
    NSGradient *gradient = [[NSGradient alloc] initWithColors:@[
        [NSColor colorWithSRGBRed:0.32 green:0.52 blue:1.00 alpha:0.34],
        [NSColor colorWithSRGBRed:0.72 green:0.42 blue:0.96 alpha:0.24],
        [NSColor colorWithSRGBRed:1.00 green:0.62 blue:0.34 alpha:0.20]
    ]];
    [gradient drawInRect:self.bounds angle:-45.0];
}
@end

#pragma mark - 内容根视图（记录 safe area，便于确认标题栏避让）

@interface RootView : GradientView
@property (nonatomic, assign) NSEdgeInsets lastInsets;
@property (nonatomic, assign) BOOL hasLoggedInsets;
@end

@implementation RootView
- (void)layout {
    [super layout];
    NSEdgeInsets insets = self.safeAreaInsets;
    BOOL changed = !self.hasLoggedInsets ||
        fabs(insets.top - self.lastInsets.top) > 0.5 ||
        fabs(insets.left - self.lastInsets.left) > 0.5 ||
        fabs(insets.bottom - self.lastInsets.bottom) > 0.5 ||
        fabs(insets.right - self.lastInsets.right) > 0.5;
    if (changed) {
        self.lastInsets = insets;
        self.hasLoggedInsets = YES;
        PoCLog(@"root safeArea top=%.1f left=%.1f bottom=%.1f right=%.1f",
               insets.top, insets.left, insets.bottom, insets.right);
    }
}
@end

#pragma mark - curve 曲率图示

@interface CurveDiagramView : NSView
@property (nonatomic, assign) double curve;
@end

@implementation CurveDiagramView

- (instancetype)initWithFrame:(NSRect)frame {
    if ((self = [super initWithFrame:frame])) {
        _curve = 0.0;
    }
    return self;
}

- (NSSize)intrinsicContentSize { return NSMakeSize(104.0, 40.0); }

- (void)setCurve:(double)curve {
    _curve = curve;
    [self setNeedsDisplay:YES];
}

- (void)drawRect:(NSRect)dirtyRect {
    NSRect bounds = NSInsetRect(self.bounds, 2.0, 5.0);
    CGFloat width = bounds.size.width;
    CGFloat height = bounds.size.height;
    if (width <= 1.0 || height <= 1.0) { return; }

    /* 虚线：线性参考 */
    NSBezierPath *linear = [NSBezierPath bezierPath];
    [linear moveToPoint:NSMakePoint(NSMinX(bounds), NSMinY(bounds))];
    [linear lineToPoint:NSMakePoint(NSMaxX(bounds), NSMaxY(bounds))];
    linear.lineWidth = 1.0;
    CGFloat dash[2] = {2.5, 2.5};
    [linear setLineDash:dash count:2 phase:0.0];
    [[NSColor tertiaryLabelColor] setStroke];
    [linear stroke];

    /* 曲线：w = t ^ (e ^ (-curve)) */
    NSBezierPath *curvePath = [NSBezierPath bezierPath];
    const int steps = 48;
    double exponent = exp(-self.curve);
    for (int i = 0; i <= steps; i++) {
        double t = (double)i / (double)steps;
        double y = pow(t, exponent);
        NSPoint point = NSMakePoint(NSMinX(bounds) + t * width,
                                    NSMinY(bounds) + y * height);
        if (i == 0) { [curvePath moveToPoint:point]; }
        else { [curvePath lineToPoint:point]; }
    }
    curvePath.lineWidth = 1.8;
    [[NSColor controlAccentColor] setStroke];
    [curvePath stroke];
}

@end

#pragma mark - JS → Swift 消息

@protocol BridgeTarget <NSObject>
- (void)handleBridgeMessage:(id)body;
@end

@interface BridgeHandler : NSObject <WKScriptMessageHandler>
@property (nonatomic, weak) id<BridgeTarget> target;
- (instancetype)initWithTarget:(id<BridgeTarget>)target;
@end

@implementation BridgeHandler
- (instancetype)initWithTarget:(id<BridgeTarget>)target {
    if ((self = [super init])) { _target = target; }
    return self;
}
- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message {
    [self.target handleBridgeMessage:message.body];
}
@end

#pragma mark - AppDelegate

@interface AppDelegate : NSObject <NSApplicationDelegate,
                                  WKNavigationDelegate,
                                  WKDownloadDelegate,
                                  NSToolbarDelegate,
                                  NSTableViewDataSource,
                                  NSTableViewDelegate,
                                  BridgeTarget>

@property (nonatomic, strong) NSWindow *window;
@property (nonatomic, strong) NSSplitViewController *splitViewController;
@property (nonatomic, strong) NSTableView *sidebarTable;
@property (nonatomic, strong) WKWebView *webView;          // 环形调制
@property (nonatomic, strong) WKWebView *interpWebView;    // 插值
@property (nonatomic, strong) WKWebView *vfWebView;        // 虚拟基音
@property (nonatomic, strong) WKWebView *rhythmWebView;    // 节奏插值
@property (nonatomic, assign) NSInteger activeTool;        // 0 环形调制 / 1 插值 / 2 虚拟基音 / 3 节奏插值
@property (nonatomic, strong) NSDictionary *ringState;
@property (nonatomic, strong) NSDictionary *interpState;
@property (nonatomic, strong) NSDictionary *vfState;
@property (nonatomic, strong) NSDictionary *rhythmState;
@property (nonatomic, strong) NSView *placeholderView;
@property (nonatomic, strong) NSViewController *contentViewController;
/* 悬浮条重新量宽用：内容视图 / 行栈 / 玻璃外壳 */
@property (nonatomic, strong) NSStackView *panelRow;
@property (nonatomic, strong) NSView *panelContent;
@property (nonatomic, strong) NSView *panelMaterial;
@property (nonatomic, assign) BOOL buildingTransportPanel;

/* 独立悬浮面板 */
@property (nonatomic, strong) NSPanel *transportPanel;
@property (nonatomic, strong) NSTextField *readoutLabel;
@property (nonatomic, strong) NSTextField *readoutLabel2;
@property (nonatomic, strong) NSTextField *statusLabel;
@property (nonatomic, strong) CurveDiagramView *curveView;
@property (nonatomic, strong) NSButton *pinButton;
@property (nonatomic, assign) BOOL panelPinned;
@property (nonatomic, assign) BOOL panelVisible;
@property (nonatomic, assign) BOOL useGlassMaterial;
@property (nonatomic, strong) NSMenuItem *panelMenuItem;
@property (nonatomic, strong) NSMenuItem *pinMenuItem;
@property (nonatomic, strong) NSMenuItem *glassMaterialMenuItem;
@property (nonatomic, strong) NSMenuItem *frostedMaterialMenuItem;

/* 心跳 / 音频连续性诊断 */
@property (nonatomic, assign) NSInteger heartbeatCount;
@property (nonatomic, assign) double lastAudioTime;
@property (nonatomic, assign) NSInteger selectedRow;
@property (nonatomic, assign) BOOL launchComplete;
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)note {
    PoCLog(@"applicationDidFinishLaunching");
    self.panelPinned = YES;
    self.panelVisible = YES;
    /* 固定使用真玻璃；只有调试时建 /tmp/poc-use-frosted 才切磨砂 */
    self.useGlassMaterial = !POCFlag(@"poc-use-frosted");

    [self buildMenu];
    PoCLog(@"menu built");
    [self buildWindow];
    PoCLog(@"window built");
    if (!POCFlag(@"poc-no-panel")) {
        [self rebuildTransportPanel];
        PoCLog(@"transport panel built");
    } else {
        PoCLog(@"transport panel disabled");
    }

    __block NSInteger beats = 0;
    [NSTimer scheduledTimerWithTimeInterval:1.0 repeats:YES block:^(NSTimer *timer) {
        beats++;
        if (beats <= 10) { PoCLog(@"heartbeat %ld", (long)beats); }
        if (beats == 10) { [timer invalidate]; }
    }];
    PoCLog(@"heartbeat timer scheduled");
    self.launchComplete = YES;
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }

#pragma mark 主窗口

- (void)buildWindow {
    NSRect rect = NSMakeRect(0, 0, 1200, 780);
    NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                              NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable |
                              NSWindowStyleMaskFullSizeContentView;
    self.window = [[NSWindow alloc] initWithContentRect:rect styleMask:style
                                                backing:NSBackingStoreBuffered defer:NO];
    self.window.title = kAppTitle;
    self.window.minSize = NSMakeSize(900, 620);
    self.window.titlebarAppearsTransparent = YES;
    self.window.titleVisibility = NSWindowTitleHidden;
    /* 允许拖动窗口背景（渐变边框区域），不再只能拖侧边栏 */
    self.window.movableByWindowBackground = YES;
    if (@available(macOS 11.0, *)) {
        self.window.toolbarStyle = NSWindowToolbarStyleUnified;
    }
    [self.window center];

    self.splitViewController = [[NSSplitViewController alloc] init];
    [self.splitViewController addSplitViewItem:[self makeSidebarItem]];
    [self.splitViewController addSplitViewItem:[self makeContentItem]];
    self.window.contentViewController = self.splitViewController;

    NSToolbar *toolbar = [[NSToolbar alloc] initWithIdentifier:@"composer-tools-poc"];
    toolbar.delegate = self;
    toolbar.displayMode = NSToolbarDisplayModeIconOnly;
    toolbar.allowsUserCustomization = YES;
    self.window.toolbar = toolbar;

    if (POCFlag(@"poc-dark")) {
        NSAppearance *dark = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
        self.window.appearance = dark;
        if (self.webView) { self.webView.appearance = dark; }
        if (self.interpWebView) { self.interpWebView.appearance = dark; }
        PoCLog(@"forced dark appearance");
    }

    [self.window makeKeyAndOrderFront:nil];
    [self loadPage];
}

- (NSSplitViewItem *)makeSidebarItem {
    NSTableView *table = [[NSTableView alloc] initWithFrame:NSZeroRect];
    if (@available(macOS 11.0, *)) { table.style = NSTableViewStyleSourceList; }
    NSTableColumn *column = [[NSTableColumn alloc] initWithIdentifier:@"main"];
    column.resizingMask = NSTableColumnAutoresizingMask;
    [table addTableColumn:column];
    table.headerView = nil;
    table.rowHeight = 30.0;
    table.dataSource = self;
    table.delegate = self;
    table.allowsEmptySelection = NO;
    self.sidebarTable = table;
    /* 启动时默认打开第一个工具；在 /tmp 建 poc-start-tool-N（N = 0…3）可指定 */
    NSInteger startTool = 0;
    for (NSInteger candidate = 0; candidate <= 3; candidate++) {
        if (POCFlag([NSString stringWithFormat:@"poc-start-tool-%ld", (long)candidate])) {
            startTool = candidate;
            break;
        }
    }
    [table selectRowIndexes:[NSIndexSet indexSetWithIndex:startTool] byExtendingSelection:NO];
    PoCLog(@"sidebar built startTool=%ld rows=%ld selected=%ld dataSource=%d delegate=%d",
           (long)startTool, (long)table.numberOfRows, (long)table.selectedRow,
           table.dataSource != nil, table.delegate != nil);

    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSZeroRect];
    scroll.documentView = table;
    scroll.hasVerticalScroller = YES;
    scroll.drawsBackground = NO;
    scroll.translatesAutoresizingMaskIntoConstraints = NO;

    NSViewController *vc = [[NSViewController alloc] init];
    vc.view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 220, 600)];
    [vc.view addSubview:scroll];
    [NSLayoutConstraint activateConstraints:@[
        [scroll.leadingAnchor constraintEqualToAnchor:vc.view.leadingAnchor],
        [scroll.trailingAnchor constraintEqualToAnchor:vc.view.trailingAnchor],
        [scroll.topAnchor constraintEqualToAnchor:vc.view.topAnchor],
        [scroll.bottomAnchor constraintEqualToAnchor:vc.view.bottomAnchor]
    ]];

    NSSplitViewItem *item = [NSSplitViewItem sidebarWithViewController:vc];
    item.minimumThickness = 180.0;
    item.maximumThickness = 280.0;
    item.canCollapse = YES;
    return item;
}

- (WKWebView *)makeWebViewWithFrame:(NSRect)frame {
    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    WKUserContentController *controller = [[WKUserContentController alloc] init];
    [controller addScriptMessageHandler:[[BridgeHandler alloc] initWithTarget:self] name:@"bridge"];
    config.userContentController = controller;
    if (@available(macOS 10.15, *)) {
        config.defaultWebpagePreferences.allowsContentJavaScript = YES;
    }
    WKWebView *web = [[WKWebView alloc] initWithFrame:frame configuration:config];
    [web setValue:@NO forKey:@"drawsBackground"];
    if (@available(macOS 12.0, *)) {
        web.underPageBackgroundColor = NSColor.clearColor;
    }
    web.navigationDelegate = self;
    return web;
}

- (NSSplitViewItem *)makeContentItem {
    RootView *root = [[RootView alloc] initWithFrame:NSMakeRect(0, 0, 960, 700)];
    root.wantsLayer = YES;
    NSMutableArray<NSLayoutConstraint *> *constraints = [NSMutableArray array];

    if (!POCFlag(@"poc-no-web")) {
        self.webView = [self makeWebViewWithFrame:root.bounds];
        self.webView.translatesAutoresizingMaskIntoConstraints = NO;
        [root addSubview:self.webView];

        if (!POCFlag(@"poc-no-interp")) {
            self.interpWebView = [self makeWebViewWithFrame:root.bounds];
            self.interpWebView.translatesAutoresizingMaskIntoConstraints = NO;
            self.interpWebView.hidden = YES;
            [root addSubview:self.interpWebView];
        }

        if (!POCFlag(@"poc-no-vf")) {
            self.vfWebView = [self makeWebViewWithFrame:root.bounds];
            self.vfWebView.translatesAutoresizingMaskIntoConstraints = NO;
            self.vfWebView.hidden = YES;
            [root addSubview:self.vfWebView];
        }

        if (!POCFlag(@"poc-no-rhythm")) {
            self.rhythmWebView = [self makeWebViewWithFrame:root.bounds];
            self.rhythmWebView.translatesAutoresizingMaskIntoConstraints = NO;
            self.rhythmWebView.hidden = YES;
            [root addSubview:self.rhythmWebView];
        }

        NSMutableArray<NSView *> *webs = [NSMutableArray arrayWithObject:self.webView];
        if (self.interpWebView) { [webs addObject:self.interpWebView]; }
        if (self.vfWebView) { [webs addObject:self.vfWebView]; }
        if (self.rhythmWebView) { [webs addObject:self.rhythmWebView]; }
        for (NSView *web in webs) {
            [constraints addObjectsFromArray:@[
                [web.leadingAnchor constraintEqualToAnchor:root.safeAreaLayoutGuide.leadingAnchor constant:10.0],
                [web.trailingAnchor constraintEqualToAnchor:root.safeAreaLayoutGuide.trailingAnchor constant:-10.0],
                [web.topAnchor constraintEqualToAnchor:root.safeAreaLayoutGuide.topAnchor constant:10.0],
                [web.bottomAnchor constraintEqualToAnchor:root.safeAreaLayoutGuide.bottomAnchor constant:-10.0]
            ]];
        }
        PoCLog(@"content: web views created");
        /* 侧边栏早期选中的工具要在这里补一次可见性（见 applyToolVisibility 注释） */
        [self applyToolVisibility];
    } else {
        PoCLog(@"content: web view disabled");
    }

    if (!POCFlag(@"poc-no-placeholder")) {
        self.placeholderView = [self makePlaceholder];
        self.placeholderView.hidden = YES;
        [root addSubview:self.placeholderView];
        [constraints addObjectsFromArray:@[
            [self.placeholderView.centerXAnchor constraintEqualToAnchor:root.centerXAnchor],
            [self.placeholderView.centerYAnchor constraintEqualToAnchor:root.centerYAnchor]
        ]];
    }

    [NSLayoutConstraint activateConstraints:constraints];

    NSViewController *vc = [[NSViewController alloc] init];
    vc.view = root;
    self.contentViewController = vc;

    NSSplitViewItem *item = [NSSplitViewItem splitViewItemWithViewController:vc];
    item.canCollapse = NO;
    return item;
}

- (NSView *)makePlaceholder {
    NSImageView *icon = [[NSImageView alloc] initWithFrame:NSZeroRect];
    icon.translatesAutoresizingMaskIntoConstraints = NO;
    icon.image = [NSImage imageWithSystemSymbolName:@"chart.xyaxis.line" accessibilityDescription:nil];
    icon.symbolConfiguration = [NSImageSymbolConfiguration configurationWithPointSize:42 weight:NSFontWeightRegular];
    icon.contentTintColor = NSColor.secondaryLabelColor;

    NSTextField *title = [NSTextField labelWithString:@"插值计算器"];
    title.font = [NSFont systemFontOfSize:20 weight:NSFontWeightSemibold];
    title.alignment = NSTextAlignmentCenter;

    NSTextField *subtitle = [NSTextField labelWithString:@"下一步把插值页面搬进同一个外壳"];
    subtitle.font = [NSFont systemFontOfSize:13];
    subtitle.textColor = NSColor.secondaryLabelColor;
    subtitle.alignment = NSTextAlignmentCenter;

    NSStackView *stack = [NSStackView stackViewWithViews:@[icon, title, subtitle]];
    stack.orientation = NSUserInterfaceLayoutOrientationVertical;
    stack.alignment = NSLayoutAttributeCenterX;
    stack.spacing = 10.0;
    stack.translatesAutoresizingMaskIntoConstraints = NO;

    NSView *container = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 360, 160)];
    container.translatesAutoresizingMaskIntoConstraints = NO;
    [container addSubview:stack];
    [NSLayoutConstraint activateConstraints:@[
        [stack.centerXAnchor constraintEqualToAnchor:container.centerXAnchor],
        [stack.centerYAnchor constraintEqualToAnchor:container.centerYAnchor],
        [container.widthAnchor constraintEqualToConstant:360.0],
        [container.heightAnchor constraintEqualToConstant:160.0]
    ]];
    return container;
}

#pragma mark 悬浮面板内容

- (NSButton *)barButton:(NSString *)title symbol:(NSString *)symbol action:(SEL)action {
    NSButton *button = [NSButton buttonWithTitle:title target:self action:action];
    button.bordered = NO;
    button.image = [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:title];
    button.imagePosition = NSImageLeading;
    button.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
    button.contentTintColor = NSColor.labelColor;
    return button;
}

- (NSButton *)iconButton:(NSString *)symbol action:(SEL)action tooltip:(NSString *)tooltip {
    NSButton *button = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:symbol
                                                          accessibilityDescription:tooltip]
                                          target:self action:action];
    button.bordered = NO;
    button.toolTip = tooltip;
    button.accessibilityLabel = tooltip;
    button.contentTintColor = NSColor.labelColor;
    return button;
}

- (NSView *)makeTransportContent {
    self.buildingTransportPanel = YES;
    self.curveView = nil;
    NSArray<NSButton *> *toolButtons;
    if (self.activeTool == 1) {
        toolButtons = @[
            [self barButton:@"播放" symbol:@"play.fill" action:@selector(playInterp:)],
            [self iconButton:@"stop.fill" action:@selector(stopInterp:) tooltip:@"停止"],
            [self iconButton:@"square.and.arrow.up" action:@selector(exportInterpMidi:) tooltip:@"导出 MIDI"],
            [self iconButton:@"doc.richtext" action:@selector(exportInterpSvg:) tooltip:@"导出五线谱 SVG"]
        ];
    } else if (self.activeTool == 2) {
        toolButtons = @[
            [self barButton:@"播放" symbol:@"play.fill" action:@selector(playVf:)],
            [self iconButton:@"stop.fill" action:@selector(stopVf:) tooltip:@"停止"],
            [self iconButton:@"square.and.arrow.up" action:@selector(exportVfMidi:) tooltip:@"导出 MIDI"],
            [self iconButton:@"doc.richtext" action:@selector(exportVfSvg:) tooltip:@"导出五线谱 SVG"]
        ];
    } else if (self.activeTool == 3) {
        toolButtons = @[
            [self barButton:@"播放" symbol:@"play.fill" action:@selector(playRhythm:)],
            [self iconButton:@"stop.fill" action:@selector(stopRhythm:) tooltip:@"停止"],
            [self iconButton:@"square.and.arrow.up" action:@selector(exportRhythmMidi:) tooltip:@"导出 MIDI"],
            [self iconButton:@"doc.richtext" action:@selector(exportRhythmSvg:) tooltip:@"导出五线谱 SVG"]
        ];
    } else {
        toolButtons = @[
            [self barButton:@"两音" symbol:@"waveform" action:@selector(playDyad:)],
            [self barButton:@"环形调制" symbol:@"waveform.path" action:@selector(playRing:)],
            [self barButton:@"和音 + 差音" symbol:@"plus.forwardslash.minus" action:@selector(playSumDiff:)],
            [self barButton:@"停止" symbol:@"stop.fill" action:@selector(stopAudio:)]
        ];
    }

    self.pinButton = [self iconButton:(self.panelPinned ? @"pin.fill" : @"pin")
                               action:@selector(togglePin:)
                              tooltip:@"置顶（主窗口最小化后仍保留）"];
    NSButton *restore = [self iconButton:@"arrow.up.forward.app"
                                  action:@selector(restoreMainWindow:)
                                 tooltip:@"还原主窗口"];
    NSButton *hide = [self iconButton:@"xmark"
                               action:@selector(hidePanel:)
                              tooltip:@"隐藏悬浮条"];

    NSBox *divider1 = [[NSBox alloc] initWithFrame:NSZeroRect];
    divider1.boxType = NSBoxSeparator;
    [divider1.widthAnchor constraintEqualToConstant:1.0].active = YES;
    [divider1.heightAnchor constraintEqualToConstant:20.0].active = YES;

    NSBox *divider2 = [[NSBox alloc] initWithFrame:NSZeroRect];
    divider2.boxType = NSBoxSeparator;
    [divider2.widthAnchor constraintEqualToConstant:1.0].active = YES;
    [divider2.heightAnchor constraintEqualToConstant:20.0].active = YES;

    self.readoutLabel = [NSTextField labelWithString:@"等待页面状态…"];
    self.readoutLabel.font = [NSFont monospacedDigitSystemFontOfSize:11.5 weight:NSFontWeightRegular];
    self.readoutLabel.maximumNumberOfLines = 1;
    self.readoutLabel.preferredMaxLayoutWidth = 560.0;
    self.readoutLabel.lineBreakMode = NSLineBreakByTruncatingTail;

    self.readoutLabel2 = [NSTextField labelWithString:@""];
    self.readoutLabel2.font = [NSFont monospacedDigitSystemFontOfSize:11.5 weight:NSFontWeightRegular];
    self.readoutLabel2.maximumNumberOfLines = 1;
    self.readoutLabel2.preferredMaxLayoutWidth = 560.0;
    self.readoutLabel2.lineBreakMode = NSLineBreakByTruncatingTail;

    self.statusLabel = [NSTextField labelWithString:@"就绪"];
    self.statusLabel.font = [NSFont systemFontOfSize:10];
    self.statusLabel.textColor = NSColor.secondaryLabelColor;
    self.statusLabel.maximumNumberOfLines = 1;
    self.statusLabel.preferredMaxLayoutWidth = 560.0;
    self.statusLabel.lineBreakMode = NSLineBreakByTruncatingTail;

    NSStackView *labels = [NSStackView stackViewWithViews:@[self.readoutLabel, self.readoutLabel2, self.statusLabel]];
    labels.orientation = NSUserInterfaceLayoutOrientationVertical;
    labels.alignment = NSLayoutAttributeLeading;
    labels.spacing = 1.0;

    NSMutableArray *rowViews = [NSMutableArray arrayWithArray:toolButtons];
    [rowViews addObject:divider1];
    [rowViews addObject:labels];
    if (self.activeTool == 1 || self.activeTool == 3) {
        self.curveView = [[CurveDiagramView alloc] initWithFrame:NSMakeRect(0, 0, 104, 40)];
        self.curveView.translatesAutoresizingMaskIntoConstraints = NO;
        [self.curveView.widthAnchor constraintEqualToConstant:104.0].active = YES;
        [self.curveView.heightAnchor constraintEqualToConstant:40.0].active = YES;
        [rowViews addObject:self.curveView];
    }
    [rowViews addObjectsFromArray:@[divider2, self.pinButton, restore, hide]];
    NSStackView *row = [NSStackView stackViewWithViews:rowViews];
    row.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    row.alignment = NSLayoutAttributeCenterY;
    row.spacing = 12.0;
    /* 先把读数填进去再量宽度：否则面板是按占位文本的宽度算的，
       真实读数一进来就被省略号截断（三个工具都会中招）。 */
    [self updatePanelReadout];
    [row layoutSubtreeIfNeeded];

    NSSize fit = row.fittingSize;
    CGFloat contentWidth = ceil(fit.width) + 32.0;
    CGFloat contentHeight = 64.0;

    NSView *content = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, contentWidth, contentHeight)];
    row.translatesAutoresizingMaskIntoConstraints = YES;
    row.frame = NSMakeRect(16.0, floor((contentHeight - fit.height) / 2.0),
                           ceil(fit.width), ceil(fit.height));
    row.autoresizingMask = NSViewMinYMargin | NSViewMaxYMargin;
    [content addSubview:row];
    self.panelRow = row;
    self.panelContent = content;
    self.buildingTransportPanel = NO;
    PoCLog(@"transport content tool=%ld glass=%d curveView=%d",
           (long)self.activeTool, self.useGlassMaterial, self.curveView != nil);
    return content;
}

- (NSView *)wrapTransportContent:(NSView *)content {
    NSRect frame = NSMakeRect(0, 0, content.frame.size.width, content.frame.size.height);
    if (self.useGlassMaterial) {
        if (@available(macOS 26.0, *)) {
            NSGlassEffectView *glass = [[NSGlassEffectView alloc] initWithFrame:frame];
            glass.style = NSGlassEffectViewStyleRegular;
            glass.cornerRadius = frame.size.height / 2.0;
            if (@available(macOS 27.0, *)) {
                glass.effectIsInteractive = YES;
            }
            content.frame = glass.bounds;
            content.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
            glass.contentView = content;
            return glass;
        }
    }
    NSVisualEffectView *effect = [[NSVisualEffectView alloc] initWithFrame:frame];
    effect.material = NSVisualEffectMaterialHUDWindow;
    effect.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    effect.state = NSVisualEffectStateActive;
    effect.wantsLayer = YES;
    effect.layer.cornerRadius = frame.size.height / 2.0;
    effect.layer.masksToBounds = YES;
    content.frame = effect.bounds;
    content.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [effect addSubview:content];
    return effect;
}

- (NSPanel *)makeTransportPanel {
    NSView *content;
    NSView *material;
    if (POCFlag(@"poc-panel-simple")) {
        NSView *container = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 260, 56)];
        NSTextField *label = [NSTextField labelWithString:@"独立面板 PoC"];
        label.font = [NSFont systemFontOfSize:14 weight:NSFontWeightMedium];
        [label sizeToFit];
        label.frame = NSMakeRect((260 - label.frame.size.width) / 2.0,
                                 (56 - label.frame.size.height) / 2.0,
                                 label.frame.size.width, label.frame.size.height);
        label.autoresizingMask = NSViewMinXMargin | NSViewMaxXMargin | NSViewMinYMargin | NSViewMaxYMargin;
        [container addSubview:label];
        content = container;
        material = container;
    } else {
        content = [self makeTransportContent];
        material = POCFlag(@"poc-panel-plain") ? content : [self wrapTransportContent:content];
    }
    self.panelMaterial = material;
    NSRect frame = NSMakeRect(0, 0, material.frame.size.width, material.frame.size.height);

    NSPanel *panel = [[NSPanel alloc] initWithContentRect:frame
                                                styleMask:(NSWindowStyleMaskBorderless |
                                                           NSWindowStyleMaskNonactivatingPanel)
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
    panel.floatingPanel = YES;
    panel.becomesKeyOnlyIfNeeded = YES;
    panel.worksWhenModal = YES;
    panel.hidesOnDeactivate = NO;
    panel.canHide = NO;
    panel.opaque = NO;
    panel.backgroundColor = NSColor.clearColor;
    panel.hasShadow = YES;
    panel.movableByWindowBackground = YES;
    panel.contentView = material;
    if (!POCFlag(@"poc-panel-no-autosave")) {
        [panel setFrameAutosaveName:kTransportFrameName];
        if (![[NSUserDefaults standardUserDefaults] stringForKey:
              [@"NSWindow Frame " stringByAppendingString:kTransportFrameName]]) {
            NSRect visible = [NSScreen mainScreen].visibleFrame;
            [panel setFrameOrigin:NSMakePoint(NSMidX(visible) - frame.size.width / 2.0,
                                              visible.origin.y + 72.0)];
        }
    }
    /* 位置可以记忆，尺寸必须跟随内容，否则切换到窄内容会留下大片右侧留白 */
    NSRect panelFrame = panel.frame;
    panelFrame.size = frame.size;
    [panel setFrame:panelFrame display:NO];
    PoCLog(@"panel content=%@ frame=%@", NSStringFromSize(frame.size), NSStringFromRect(panel.frame));
    [self applyPanelLevel];
    return panel;
}

- (void)rebuildTransportPanel {
    NSRect previousFrame = self.transportPanel ? self.transportPanel.frame : NSZeroRect;
    BOOL wasVisible = self.transportPanel ? self.transportPanel.isVisible : YES;
    if (self.transportPanel) {
        [self.transportPanel orderOut:nil];
        [self.transportPanel close];
        self.transportPanel = nil;
    }
    self.transportPanel = [self makeTransportPanel];
    [self applyPanelLevel];
    if (!NSEqualRects(previousFrame, NSZeroRect)) {
        /* 只继承旧面板的位置；尺寸用新内容算出来的尺寸 */
        NSRect newFrame = self.transportPanel.frame;
        newFrame.origin = previousFrame.origin;
        [self.transportPanel setFrame:newFrame display:NO];
    }
    PoCLog(@"panel rebuilt size=%@", NSStringFromRect(self.transportPanel.frame));
    if (wasVisible && self.panelVisible && !POCFlag(@"poc-panel-no-order")) {
        [self.transportPanel orderFrontRegardless];
    }
    [self updatePanelButtons];
}

- (void)applyPanelLevel {
    if (!self.transportPanel) { return; }
    if (self.panelPinned) {
        self.transportPanel.level = NSFloatingWindowLevel;
        self.transportPanel.collectionBehavior = (NSWindowCollectionBehaviorCanJoinAllSpaces |
                                                  NSWindowCollectionBehaviorFullScreenAuxiliary |
                                                  NSWindowCollectionBehaviorStationary |
                                                  NSWindowCollectionBehaviorIgnoresCycle);
    } else {
        self.transportPanel.level = NSNormalWindowLevel;
        self.transportPanel.collectionBehavior = NSWindowCollectionBehaviorFullScreenAuxiliary;
    }
    PoCLog(@"panel level=%ld pinned=%d", (long)self.transportPanel.level, self.panelPinned);
}

- (void)updatePanelButtons {
    self.pinButton.image = [NSImage imageWithSystemSymbolName:(self.panelPinned ? @"pin.fill" : @"pin")
                                     accessibilityDescription:@"置顶"];
    self.pinButton.toolTip = self.panelPinned ? @"取消置顶" : @"置顶（主窗口最小化后仍保留）";
    self.panelMenuItem.state = self.panelVisible ? NSControlStateValueOn : NSControlStateValueOff;
    self.pinMenuItem.state = self.panelPinned ? NSControlStateValueOn : NSControlStateValueOff;
    self.glassMaterialMenuItem.state = self.useGlassMaterial ? NSControlStateValueOn : NSControlStateValueOff;
    self.frostedMaterialMenuItem.state = self.useGlassMaterial ? NSControlStateValueOff : NSControlStateValueOn;
}

#pragma mark 面板动作

- (void)applyPanelVisibility:(BOOL)visible {
    _panelVisible = visible;
    if (!self.transportPanel) { return; }
    if (visible) {
        [self.transportPanel orderFrontRegardless];
    } else {
        [self.transportPanel orderOut:nil];
    }
    [self updatePanelButtons];
    PoCLog(@"panel visible=%d", visible);
}

- (void)togglePanel:(id)sender { [self applyPanelVisibility:!self.panelVisible]; }
- (void)hidePanel:(id)sender { [self applyPanelVisibility:NO]; }

- (void)togglePin:(id)sender {
    self.panelPinned = !self.panelPinned;
    [self applyPanelLevel];
    [self updatePanelButtons];
}

- (void)useGlassMaterial:(id)sender {
    self.useGlassMaterial = YES;
    [self rebuildTransportPanel];
}

- (void)useFrostedMaterial:(id)sender {
    self.useGlassMaterial = NO;
    [self rebuildTransportPanel];
}

- (void)toggleMaterial:(id)sender {
    if (self.useGlassMaterial) {
        [self useFrostedMaterial:sender];
    } else {
        [self useGlassMaterial:sender];
    }
    PoCLog(@"material glass=%d", self.useGlassMaterial);
}

- (void)minimizeMainWindow:(id)sender {
    [self.window performMiniaturize:sender];
    PoCLog(@"main window minimized");
}

- (void)restoreMainWindow:(id)sender {
    [self.window deminiaturize:sender];
    [self.window makeKeyAndOrderFront:sender];
    PoCLog(@"main window restored");
}

#pragma mark 页面加载与桥

- (NSURL *)urlForRelativePath:(NSString *)relativePath bundleName:(NSString *)bundleName {
    /* 默认只读 app bundle 内的资源：不访问 ~/Documents，就不会触发 TCC 授权弹窗。
       需要改网页源码时，在 /tmp 建一个 poc-use-external 文件即可切回外置路径。 */
    if (POCFlag(@"poc-use-external")) {
        NSString *external = [NSHomeDirectory() stringByAppendingPathComponent:relativePath];
        if ([[NSFileManager defaultManager] fileExistsAtPath:external]) {
            PoCLog(@"using external resource %@", external);
            return [NSURL fileURLWithPath:external];
        }
    }
    NSURL *bundled = [[NSBundle mainBundle] URLForResource:bundleName withExtension:@"html"];
    if (bundled) { return bundled; }
    NSString *external = [NSHomeDirectory() stringByAppendingPathComponent:relativePath];
    if ([[NSFileManager defaultManager] fileExistsAtPath:external]) {
        return [NSURL fileURLWithPath:external];
    }
    return nil;
}

- (void)loadPage {
    if (self.webView) {
        NSURL *url = [self urlForRelativePath:@"Documents/ChatGPT/论文paper/tools/ringmod-demo.html"
                                   bundleName:@"ringmod-demo"];
        if (url) {
            PoCLog(@"loadPage ringmod %@", url.path);
            [self.webView loadFileURL:url allowingReadAccessToURL:[url URLByDeletingLastPathComponent]];
        }
    }
    if (self.interpWebView) {
        NSURL *url = [self urlForRelativePath:@"Documents/ChatGPT/论文paper/tools/interpolation-demo.html"
                                   bundleName:@"interpolation-demo"];
        if (url) {
            PoCLog(@"loadPage interp %@", url.path);
            [self.interpWebView loadFileURL:url allowingReadAccessToURL:[url URLByDeletingLastPathComponent]];
        }
    }
    if (self.vfWebView) {
        NSURL *url = [self urlForRelativePath:@"Documents/ChatGPT/论文paper/tools/virtualfund-demo.html"
                                   bundleName:@"virtualfund-demo"];
        if (url) {
            PoCLog(@"loadPage vf %@", url.path);
            [self.vfWebView loadFileURL:url allowingReadAccessToURL:[url URLByDeletingLastPathComponent]];
        }
    }
    if (self.rhythmWebView) {
        NSURL *url = [self urlForRelativePath:@"Documents/ChatGPT/论文paper/tools/rhythm-interp-demo.html"
                                   bundleName:@"rhythm-interp-demo"];
        if (url) {
            PoCLog(@"loadPage rhythm %@", url.path);
            [self.rhythmWebView loadFileURL:url allowingReadAccessToURL:[url URLByDeletingLastPathComponent]];
        }
    }
    if (!self.webView && !self.interpWebView && !self.vfWebView && !self.rhythmWebView) {
        PoCLog(@"loadPage skipped (no web view)");
    }
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    if (webView == self.rhythmWebView) {
        PoCLog(@"didFinishNavigation rhythm");
        [self injectRhythmStyle];
    } else if (webView == self.vfWebView) {
        PoCLog(@"didFinishNavigation vf");
        [self injectVfStyle];
    } else if (webView == self.interpWebView) {
        PoCLog(@"didFinishNavigation interp");
        [self injectInterpStyle];
    } else {
        PoCLog(@"didFinishNavigation ringmod");
        [self injectRingmodBridge];
    }
}

- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(WKNavigation *)navigation {
    PoCLog(@"didStartProvisionalNavigation");
}

- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation {
    PoCLog(@"didCommitNavigation");
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    PoCLog(@"didFailProvisionalNavigation %@", error);
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    PoCLog(@"didFailNavigation %@", error);
}

- (void)webView:(WKWebView *)webView
        decidePolicyForNavigationAction:(WKNavigationAction *)action
                        decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    if (@available(macOS 11.3, *)) {
        if (action.shouldPerformDownload) {
            decisionHandler(WKNavigationActionPolicyDownload);
            return;
        }
    }
    decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView *)webView
        decidePolicyForNavigationResponse:(WKNavigationResponse *)response
                          decisionHandler:(void (^)(WKNavigationResponsePolicy))decisionHandler {
    NSString *mime = response.response.MIMEType ?: @"";
    if ([mime isEqualToString:@"image/svg+xml"] || [mime isEqualToString:@"image/png"]) {
        decisionHandler(WKNavigationResponsePolicyDownload);
        return;
    }
    decisionHandler(response.canShowMIMEType ? WKNavigationResponsePolicyAllow
                                             : WKNavigationResponsePolicyDownload);
}

- (void)webView:(WKWebView *)webView
        navigationAction:(WKNavigationAction *)navigationAction
        didBecomeDownload:(WKDownload *)download {
    download.delegate = self;
}

- (void)webView:(WKWebView *)webView
        navigationResponse:(WKNavigationResponse *)navigationResponse
        didBecomeDownload:(WKDownload *)download {
    download.delegate = self;
}

- (void)download:(WKDownload *)download
        decideDestinationUsingResponse:(NSURLResponse *)response
                     suggestedFilename:(NSString *)suggestedFilename
                     completionHandler:(void (^)(NSURL * _Nullable))completionHandler {
    NSURL *directory = [NSURL fileURLWithPath:[NSHomeDirectory() stringByAppendingPathComponent:@"Downloads"]
                                  isDirectory:YES];
    NSFileManager *manager = [NSFileManager defaultManager];
    NSURL *destination = [directory URLByAppendingPathComponent:suggestedFilename];
    NSString *base = [suggestedFilename stringByDeletingPathExtension];
    NSString *extension = [suggestedFilename pathExtension];
    int index = 2;
    while ([manager fileExistsAtPath:destination.path]) {
        destination = [directory URLByAppendingPathComponent:
                       [NSString stringWithFormat:@"%@-%d.%@", base, index++, extension]];
    }
    PoCLog(@"download -> %@", destination.path);
    completionHandler(destination);
}

- (void)downloadDidFinish:(WKDownload *)download { PoCLog(@"download finished"); }

- (NSString *)jsString:(NSString *)string {
    NSData *data = [NSJSONSerialization dataWithJSONObject:@[string] options:0 error:nil];
    NSString *array = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    return [array substringWithRange:NSMakeRange(1, array.length - 2)];
}

- (NSString *)shellCSS {
    return
        @"html, body { background: transparent !important; }"
         "body { padding: 16px 16px 132px !important; }"
         ".wrap { max-width: none !important; }"
         ".card { background: rgba(255,255,255,0.70) !important;"
         "  -webkit-backdrop-filter: blur(18px) saturate(1.25);"
         "  backdrop-filter: blur(18px) saturate(1.25);"
         "  border: 1px solid rgba(255,255,255,0.62) !important;"
         "  box-shadow: inset 0 1px 0 rgba(255,255,255,0.65), 0 10px 30px rgba(0,0,0,0.06) !important; }"
         "@media (prefers-color-scheme: dark) {"
         "  .card { background: rgba(28,28,32,0.55) !important; } }";
}

- (void)injectRingmodBridge {
    NSString *js = [NSString stringWithFormat:
        @"(function () {"
         "  if (window.__composerPoc) { return; }"
         "  window.__composerPoc = true;"
         "  const style = document.createElement('style');"
         "  style.textContent = %@;"
         "  document.head.appendChild(style);"
         "  function report(result) {"
         "    const r = result || (typeof window.compute === 'function' ? window.compute() : null);"
         "    if (!r) { return; }"
         "    const statusEl = document.getElementById('status');"
         "    const sumSnap = r.sum.snap || {};"
         "    const diffSnap = r.diff.snap || {};"
         "    try {"
         "      window.webkit.messageHandlers.bridge.postMessage({"
         "        tool: 'ringmod',"
         "        carrier: r.c.f, modulator: r.m.f, sum: r.sum.f, diff: r.diff.f,"
         "        carrierName: r.c.name || '', modulatorName: r.m.name || '',"
         "        sumName: sumSnap.name || '', diffName: diffSnap.name || '',"
         "        sumCents: (sumSnap.dev == null ? null : sumSnap.dev),"
         "        diffCents: (diffSnap.dev == null ? null : diffSnap.dev),"
         "        status: statusEl ? statusEl.textContent : ''"
         "      });"
         "    } catch (e) {}"
         "  }"
         "  const originalRender = window.render;"
         "  if (typeof originalRender === 'function') {"
         "    window.render = function () {"
         "      const r = originalRender.apply(this, arguments);"
         "      report(r);"
         "      return r;"
         "    };"
         "  }"
         "  report();"
         "  setInterval(function () {"
         "    try {"
         "      const hasCtx = (typeof ctx !== 'undefined' && ctx);"
         "      window.webkit.messageHandlers.bridge.postMessage({"
         "        heartbeat: Date.now(),"
         "        audioState: hasCtx ? ctx.state : 'none',"
         "        audioTime: hasCtx ? ctx.currentTime : 0"
         "      });"
         "    } catch (e) {}"
         "  }, 1000);"
         "})();", [self jsString:[self shellCSS]]];
    [self.webView evaluateJavaScript:js completionHandler:^(id result, NSError *error) {
        PoCLog(@"injectRingmodBridge done error=%@", error);
    }];
    if (POCFlag(@"poc-debug-styles")) {
        NSString *debug = @"(function(){var ids=['c-group','c-note','m-group','m-note','export-svg','export-png','edo'];var o={};ids.forEach(function(id){var el=document.getElementById(id);if(el){var cs=getComputedStyle(el);o[id]=cs.backgroundColor+' | '+cs.color;}});try{window.webkit.messageHandlers.bridge.postMessage({tool:'ringmod',styles:o});}catch(e){}})();";
        [self.webView evaluateJavaScript:debug completionHandler:nil];
    }
}

- (void)injectInterpStyle {
    if (!self.interpWebView) { return; }
    NSString *js = [NSString stringWithFormat:
        @"(function () {"
         "  if (window.__composerPocStyle) { return; }"
         "  window.__composerPocStyle = true;"
         "  window.addEventListener('error', function (e) {"
         "    try { window.webkit.messageHandlers.bridge.postMessage({ tool: 'interp', jsError: String(e.message || e) }); } catch (err) {}"
         "  });"
         "  const style = document.createElement('style');"
         "  style.textContent = %@;"
         "  document.head.appendChild(style);"
         "})();", [self jsString:[self shellCSS]]];
    [self.interpWebView evaluateJavaScript:js completionHandler:^(id result, NSError *error) {
        PoCLog(@"injectInterpStyle done error=%@", error);
    }];
    if (POCFlag(@"poc-debug-styles")) {
        NSString *debug = @"(function(){var ids=['a-text','b-text','export-midi','export-svg','domain'];var o={};ids.forEach(function(id){var el=document.getElementById(id);if(el){var cs=getComputedStyle(el);o[id]=cs.backgroundColor+' | '+cs.color;}});try{window.webkit.messageHandlers.bridge.postMessage({tool:'interp',styles:o});}catch(e){}})();";
        [self.interpWebView evaluateJavaScript:debug completionHandler:nil];
    }
}

- (void)injectVfStyle {
    if (!self.vfWebView) { return; }
    NSString *js = [NSString stringWithFormat:
        @"(function () {"
         "  if (window.__composerPocStyle) { return; }"
         "  window.__composerPocStyle = true;"
         "  window.addEventListener('error', function (e) {"
         "    try { window.webkit.messageHandlers.bridge.postMessage({ tool: 'vf', jsError: String(e.message || e) }); } catch (err) {}"
         "  });"
         "  const style = document.createElement('style');"
         "  style.textContent = %@;"
         "  document.head.appendChild(style);"
         "})();", [self jsString:[self shellCSS]]];
    [self.vfWebView evaluateJavaScript:js completionHandler:^(id result, NSError *error) {
        PoCLog(@"injectVfStyle done error=%@", error);
    }];
}

- (void)injectRhythmStyle {
    if (!self.rhythmWebView) { return; }
    NSString *js = [NSString stringWithFormat:
        @"(function () {"
         "  if (window.__composerPocStyle) { return; }"
         "  window.__composerPocStyle = true;"
         "  window.addEventListener('error', function (e) {"
         "    try { window.webkit.messageHandlers.bridge.postMessage({ tool: 'rhythm', jsError: String(e.message || e) }); } catch (err) {}"
         "  });"
         "  const style = document.createElement('style');"
         "  style.textContent = %@;"
         "  document.head.appendChild(style);"
         "})();", [self jsString:[self shellCSS]]];
    [self.rhythmWebView evaluateJavaScript:js completionHandler:^(id result, NSError *error) {
        PoCLog(@"injectRhythmStyle done error=%@", error);
    }];
}

- (void)handleBridgeMessage:(id)body {
    if (![body isKindOfClass:[NSDictionary class]]) { return; }
    NSDictionary *dict = (NSDictionary *)body;
    NSString *tool = [dict[@"tool"] isKindOfClass:[NSString class]] ? dict[@"tool"] : @"ringmod";

    if (dict[@"styles"]) {
        PoCLog(@"computed styles[%@]: %@", tool, dict[@"styles"]);
        return;
    }

    if (dict[@"heartbeat"]) {
        self.heartbeatCount++;
        NSString *audioState = [dict[@"audioState"] isKindOfClass:[NSString class]] ? dict[@"audioState"] : @"";
        double audioTime = [dict[@"audioTime"] doubleValue];
        self.lastAudioTime = audioTime;
        if (self.heartbeatCount % 3 == 0) {
            PoCLog(@"js-heartbeat[%@] #%ld audio=%@ t=%.2f", tool, (long)self.heartbeatCount, audioState, audioTime);
        }
        return;
    }

    if ([tool isEqualToString:@"interp"]) {
        self.interpState = dict;
        if (dict[@"jsError"]) {
            PoCLog(@"interp JS error: %@", dict[@"jsError"]);
            return;
        }
        static NSInteger interpCount = 0;
        if (interpCount++ < 8) {
            PoCLog(@"bridge interp #%ld chords=%@ voices=%@ step=%@ playing=%@",
                   (long)interpCount, dict[@"chords"], dict[@"voices"], dict[@"step"], dict[@"playing"]);
        }
        [self updatePanelReadout];
        return;
    }

    if ([tool isEqualToString:@"vf"]) {
        self.vfState = dict;
        if (dict[@"jsError"]) {
            PoCLog(@"vf JS error: %@", dict[@"jsError"]);
            return;
        }
        static NSInteger vfCount = 0;
        if (vfCount++ < 8) {
            PoCLog(@"bridge vf #%ld chord=%@ fund=%@ partials=%@",
                   (long)vfCount, dict[@"chordSize"], dict[@"fundName"], dict[@"partials"]);
        }
        [self updatePanelReadout];
        return;
    }

    if ([tool isEqualToString:@"rhythm"]) {
        self.rhythmState = dict;
        if (dict[@"jsError"]) {
            PoCLog(@"rhythm JS error: %@", dict[@"jsError"]);
            return;
        }
        static NSInteger rhythmCount = 0;
        if (rhythmCount++ < 8) {
            PoCLog(@"bridge rhythm #%ld steps=%@ strategy=%@ meter=%@",
                   (long)rhythmCount, dict[@"steps"], dict[@"strategy"], dict[@"meter"]);
        }
        [self updatePanelReadout];
        return;
    }

    self.ringState = dict;
    static NSInteger bridgeCount = 0;
    if (bridgeCount++ < 8) {
        PoCLog(@"bridge ringmod #%ld carrier=%@ mod=%@ sum=%@ diff=%@",
               (long)bridgeCount, dict[@"carrierName"], dict[@"modulatorName"],
               dict[@"sumName"], dict[@"diffName"]);
    }
    [self updatePanelReadout];
}

/* 读数变化后要把悬浮条重新量宽：面板是按建面板那一刻的文本宽度算出来的，
   而读数往往在页面加载完之后才到（尤其虚拟基音），不重量就会被省略号截断。 */
- (void)relayoutTransportPanel {
    if (!self.transportPanel || !self.panelRow || !self.panelContent) { return; }
    NSStackView *row = self.panelRow;
    [row layoutSubtreeIfNeeded];
    NSSize fit = row.fittingSize;
    CGFloat contentWidth = ceil(fit.width) + 32.0;
    CGFloat contentHeight = 64.0;

    self.panelContent.frame = NSMakeRect(0, 0, contentWidth, contentHeight);
    row.frame = NSMakeRect(16.0, floor((contentHeight - fit.height) / 2.0),
                           ceil(fit.width), ceil(fit.height));
    if (self.panelMaterial) {
        self.panelMaterial.frame = NSMakeRect(0, 0, contentWidth, contentHeight);
    }

    NSRect oldFrame = self.transportPanel.frame;
    NSRect newFrame = oldFrame;
    newFrame.size = NSMakeSize(contentWidth, contentHeight);
    newFrame.origin.y = NSMaxY(oldFrame) - newFrame.size.height;   /* 上边缘不动 */
    if (NSEqualRects(oldFrame, newFrame)) { return; }
    [self.transportPanel setFrame:newFrame display:YES];
    PoCLog(@"panel resized %.0fx%.0f -> %.0fx%.0f",
           oldFrame.size.width, oldFrame.size.height, newFrame.size.width, newFrame.size.height);
}

- (void)updatePanelReadout {
    [self updatePanelReadoutText];
    if (!self.buildingTransportPanel) { [self relayoutTransportPanel]; }
}

- (void)updatePanelReadoutText {
    if (!self.readoutLabel) { return; }

    if (self.activeTool == 1) {
        NSDictionary *s = self.interpState ?: @{};
        NSInteger chords = [s[@"chords"] integerValue];
        NSInteger voices = [s[@"voices"] integerValue];
        double curve = [s[@"curve"] doubleValue];
        NSString *domain = [s[@"domain"] isKindOfClass:[NSString class]] ? s[@"domain"] : @"midi";
        NSInteger step = [s[@"step"] integerValue];
        BOOL playing = [s[@"playing"] boolValue];
        if (self.curveView) { self.curveView.curve = curve; }
        static double lastLoggedCurve = 9999.0;
        if (fabs(curve - lastLoggedCurve) > 1e-6) {
            PoCLog(@"interp curve updated %.3f", curve);
            lastLoggedCurve = curve;
        }
        NSString *stepText = (playing && step > 0 && chords > 0)
            ? [NSString stringWithFormat:@" · 第 %ld/%ld 步", (long)step, (long)chords]
            : @"";
        self.readoutLabel.stringValue = [NSString stringWithFormat:@"%ld 个和弦 · %ld 个声部",
                                         (long)chords, (long)voices];
        self.readoutLabel2.stringValue = [NSString stringWithFormat:@"%@ · curve %.2f%@",
                                          [domain isEqualToString:@"freq"] ? @"频率域" : @"MIDI 域",
                                          curve, stepText];
        self.statusLabel.stringValue = playing ? @"播放中" : @"就绪";
        return;
    }

    if (self.activeTool == 2) {
        NSDictionary *s = self.vfState ?: @{};
        NSString *fundName = [s[@"fundName"] isKindOfClass:[NSString class]] ? s[@"fundName"] : @"";
        NSString *partials = [s[@"partials"] isKindOfClass:[NSString class]] ? s[@"partials"] : @"";
        NSString *reason = [s[@"reason"] isKindOfClass:[NSString class]] ? s[@"reason"] : @"";
        double fundFreq = [s[@"fundFreq"] doubleValue];
        double cents = [s[@"cents"] doubleValue];
        double maxOff = [s[@"maxCentsOff"] doubleValue];
        BOOL ok = [s[@"ok"] boolValue];
        BOOL audible = [s[@"audible"] boolValue];
        BOOL playing = [s[@"playing"] boolValue];

        if (!ok) {
            NSString *why = @"无解";
            if ([reason isEqualToString:@"empty"]) { why = @"还没有选音"; }
            else if ([reason isEqualToString:@"budget"]) { why = @"搜索超出预算"; }
            self.readoutLabel.stringValue = [NSString stringWithFormat:@"%@ · 容差 %.0f¢", why, cents];
            self.readoutLabel2.stringValue = [reason isEqualToString:@"no-solution"]
                ? @"这个容差下不存在整数倍泛音基音，把容差调大试试" : @"";
            self.statusLabel.stringValue = playing ? @"播放中" : @"就绪";
            return;
        }

        self.readoutLabel.stringValue = [NSString stringWithFormat:@"虚基音 %@ · %.2f Hz",
                                         fundName, fundFreq];
        self.readoutLabel2.stringValue = [NSString stringWithFormat:@"泛音 %@ · 最大偏差 %.1f¢（容差 %.0f¢）%@",
                                          partials, maxOff, cents, audible ? @"" : @" · ⚠ 亚音"];
        self.statusLabel.stringValue = playing ? @"播放中" : (audible ? @"就绪" : @"亚音，无音乐意义");
        return;
    }

    if (self.activeTool == 3) {
        NSDictionary *s = self.rhythmState ?: @{};
        NSInteger steps = [s[@"steps"] integerValue];
        NSInteger samples = [s[@"samples"] integerValue];
        NSString *strategy = [s[@"strategy"] isKindOfClass:[NSString class]] ? s[@"strategy"] : @"dx";
        NSString *meter = [s[@"meter"] isKindOfClass:[NSString class]] ? s[@"meter"] : @"4/4";
        NSString *engine = [s[@"engine"] isKindOfClass:[NSString class]] ? s[@"engine"] : @"global";
        double curve = [s[@"curve"] doubleValue];
        BOOL playing = [s[@"playing"] boolValue];
        if (self.curveView) { self.curveView.curve = curve; }
        self.readoutLabel.stringValue = [NSString stringWithFormat:@"%ld 个中间状态 · %ld 步 · %@",
                                         (long)steps, (long)samples,
                                         [meter stringByAppendingString:@" 拍"]];
        self.readoutLabel2.stringValue = [NSString stringWithFormat:@"%@ · curve %.2f · %@",
                                          [strategy isEqualToString:@"dx"] ? @"逐项时值" : @"时间弯曲",
                                          curve,
                                          [engine isEqualToString:@"global"] ? @"全局量化" : @"等值连音扫描"];
        self.statusLabel.stringValue = playing ? @"播放中" : @"就绪";
        return;
    }

    NSDictionary *dict = self.ringState ?: @{};
    double carrier = [dict[@"carrier"] doubleValue];
    double modulator = [dict[@"modulator"] doubleValue];
    double sum = [dict[@"sum"] doubleValue];
    double diff = [dict[@"diff"] doubleValue];
    NSString *carrierName = [dict[@"carrierName"] isKindOfClass:[NSString class]] ? dict[@"carrierName"] : @"";
    NSString *modulatorName = [dict[@"modulatorName"] isKindOfClass:[NSString class]] ? dict[@"modulatorName"] : @"";
    NSString *sumName = [dict[@"sumName"] isKindOfClass:[NSString class]] ? dict[@"sumName"] : @"";
    NSString *diffName = [dict[@"diffName"] isKindOfClass:[NSString class]] ? dict[@"diffName"] : @"";
    NSString *status = [dict[@"status"] isKindOfClass:[NSString class]] ? dict[@"status"] : @"";

    NSString *carrierText = carrierName.length
        ? [NSString stringWithFormat:@"%@ %.1f Hz", carrierName, carrier]
        : [NSString stringWithFormat:@"%.1f Hz", carrier];
    NSString *modulatorText = modulatorName.length
        ? [NSString stringWithFormat:@"%@ %.1f Hz", modulatorName, modulator]
        : [NSString stringWithFormat:@"%.1f Hz", modulator];
    NSString *sumText = sumName.length
        ? [NSString stringWithFormat:@"%@ %.1f Hz", sumName, sum]
        : [NSString stringWithFormat:@"%.1f Hz", sum];
    NSString *diffText = diff < 0.01
        ? @"直流（0 Hz）"
        : (diffName.length ? [NSString stringWithFormat:@"%@ %.1f Hz", diffName, diff]
                           : [NSString stringWithFormat:@"%.1f Hz", diff]);
    self.readoutLabel.stringValue = [NSString stringWithFormat:
        @"载音 %@ · 调制音 %@", carrierText, modulatorText];
    self.readoutLabel2.stringValue = [NSString stringWithFormat:
        @"和音 %@ · 差音 %@", sumText, diffText];
    self.statusLabel.stringValue = status.length ? status : @"就绪";
}

#pragma mark 工具动作

- (void)evalJS:(NSString *)js {
    PoCLog(@"evalJS %@", js);
    [self.webView evaluateJavaScript:js completionHandler:^(id result, NSError *error) {
        if (error) { NSLog(@"PoC JS error: %@", error); }
    }];
}

- (void)playDyad:(id)sender { [self evalJS:@"play('dyad')"]; }
- (void)playRing:(id)sender { [self evalJS:@"play('ring')"]; }
- (void)playSumDiff:(id)sender { [self evalJS:@"play('sumdiff')"]; }
- (void)stopAudio:(id)sender { [self evalJS:@"killLive()"]; }
- (void)reloadPage:(id)sender {
    if (self.activeTool == 3) {
        [self.rhythmWebView reload];
    } else if (self.activeTool == 2) {
        [self.vfWebView reload];
    } else if (self.activeTool == 1) {
        [self.interpWebView reload];
    } else {
        [self.webView reload];
    }
}
- (void)exportSvg:(id)sender { [self evalJS:@"document.getElementById('export-svg').click()"]; }
- (void)exportPng:(id)sender { [self evalJS:@"document.getElementById('export-png').click()"]; }

- (void)evalInterpJS:(NSString *)js {
    PoCLog(@"evalInterpJS %@", js);
    [self.interpWebView evaluateJavaScript:js completionHandler:^(id result, NSError *error) {
        if (error) { NSLog(@"PoC interp JS error: %@", error); }
    }];
}

- (void)evalVfJS:(NSString *)js {
    PoCLog(@"evalVfJS %@", js);
    [self.vfWebView evaluateJavaScript:js completionHandler:^(id result, NSError *error) {
        if (error) { NSLog(@"PoC vf JS error: %@", error); }
    }];
}

- (void)playVf:(id)sender { [self evalVfJS:@"window.VirtualFundAPI && window.VirtualFundAPI.play()"]; }
- (void)stopVf:(id)sender { [self evalVfJS:@"window.VirtualFundAPI && window.VirtualFundAPI.stop()"]; }
- (void)exportVfMidi:(id)sender { [self evalVfJS:@"window.VirtualFundAPI && window.VirtualFundAPI.exportMidi()"]; }
- (void)exportVfSvg:(id)sender { [self evalVfJS:@"window.VirtualFundAPI && window.VirtualFundAPI.exportSvg()"]; }

- (void)evalRhythmJS:(NSString *)js {
    PoCLog(@"evalRhythmJS %@", js);
    [self.rhythmWebView evaluateJavaScript:js completionHandler:^(id result, NSError *error) {
        if (error) { NSLog(@"PoC rhythm JS error: %@", error); }
    }];
}

- (void)playRhythm:(id)sender { [self evalRhythmJS:@"window.RhythmAPI && window.RhythmAPI.play()"]; }
- (void)stopRhythm:(id)sender { [self evalRhythmJS:@"window.RhythmAPI && window.RhythmAPI.stop()"]; }
- (void)exportRhythmMidi:(id)sender { [self evalRhythmJS:@"window.RhythmAPI && window.RhythmAPI.exportMidi()"]; }
- (void)exportRhythmSvg:(id)sender { [self evalRhythmJS:@"window.RhythmAPI && window.RhythmAPI.exportSvg()"]; }

- (void)playInterp:(id)sender { [self evalInterpJS:@"window.InterpAPI && window.InterpAPI.play()"]; }
- (void)stopInterp:(id)sender { [self evalInterpJS:@"window.InterpAPI && window.InterpAPI.stop()"]; }
- (void)exportInterpMidi:(id)sender { [self evalInterpJS:@"window.InterpAPI && window.InterpAPI.exportMidi()"]; }
- (void)exportInterpSvg:(id)sender { [self evalInterpJS:@"window.InterpAPI && window.InterpAPI.exportSvg()"]; }

- (void)playCurrentTool:(id)sender {
    if (self.activeTool == 3) { [self playRhythm:sender]; }
    else if (self.activeTool == 2) { [self playVf:sender]; }
    else if (self.activeTool == 1) { [self playInterp:sender]; }
    else { [self playRing:sender]; }
}
- (void)stopCurrentTool:(id)sender {
    if (self.activeTool == 3) { [self stopRhythm:sender]; }
    else if (self.activeTool == 2) { [self stopVf:sender]; }
    else if (self.activeTool == 1) { [self stopInterp:sender]; }
    else { [self stopAudio:sender]; }
}
- (void)exportCurrentTool:(id)sender {
    if (self.activeTool == 3) { [self exportRhythmMidi:sender]; }
    else if (self.activeTool == 2) { [self exportVfMidi:sender]; }
    else if (self.activeTool == 1) { [self exportInterpMidi:sender]; }
    else { [self exportSvg:sender]; }
}

#pragma mark 工具栏

- (NSToolbarItem *)toolbar:(NSToolbar *)toolbar
     itemForItemIdentifier:(NSToolbarItemIdentifier)identifier
 willBeInsertedIntoToolbar:(BOOL)flag {
    NSToolbarItem *item = [[NSToolbarItem alloc] initWithItemIdentifier:identifier];
    if ([identifier isEqualToString:@"toggleSidebar"]) {
        item.label = @"侧边栏";
        item.image = [NSImage imageWithSystemSymbolName:@"sidebar.left" accessibilityDescription:@"侧边栏"];
        item.target = self.splitViewController;
        item.action = @selector(toggleSidebar:);
    } else if ([identifier isEqualToString:@"panel"]) {
        item.label = @"悬浮条";
        item.image = [NSImage imageWithSystemSymbolName:@"rectangle.on.rectangle" accessibilityDescription:@"悬浮条"];
        item.target = self; item.action = @selector(togglePanel:);
    } else if ([identifier isEqualToString:@"pin"]) {
        item.label = @"置顶";
        item.image = [NSImage imageWithSystemSymbolName:@"pin" accessibilityDescription:@"置顶"];
        item.target = self; item.action = @selector(togglePin:);
    } else if ([identifier isEqualToString:@"reload"]) {
        item.label = @"重新载入";
        item.image = [NSImage imageWithSystemSymbolName:@"arrow.clockwise" accessibilityDescription:@"重新载入"];
        item.target = self; item.action = @selector(reloadPage:);
    } else if ([identifier isEqualToString:@"play"]) {
        item.label = @"播放";
        item.image = [NSImage imageWithSystemSymbolName:@"play.fill" accessibilityDescription:@"播放"];
        item.target = self; item.action = @selector(playCurrentTool:);
    } else if ([identifier isEqualToString:@"stop"]) {
        item.label = @"停止";
        item.image = [NSImage imageWithSystemSymbolName:@"stop.fill" accessibilityDescription:@"停止"];
        item.target = self; item.action = @selector(stopCurrentTool:);
    } else if ([identifier isEqualToString:@"export"]) {
        item.label = @"导出当前工具";
        item.image = [NSImage imageWithSystemSymbolName:@"square.and.arrow.up" accessibilityDescription:@"导出当前工具"];
        item.target = self; item.action = @selector(exportCurrentTool:);
    } else if ([identifier isEqualToString:@"minimize"]) {
        item.label = @"最小化主窗口";
        item.image = [NSImage imageWithSystemSymbolName:@"arrow.down.right.and.arrow.up.left" accessibilityDescription:@"最小化主窗口"];
        item.target = self; item.action = @selector(minimizeMainWindow:);
    }
    return item;
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarDefaultItemIdentifiers:(NSToolbar *)toolbar {
    return @[@"toggleSidebar", @"panel", @"pin", NSToolbarFlexibleSpaceItemIdentifier,
             @"reload", @"play", @"stop", @"export", @"minimize"];
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarAllowedItemIdentifiers:(NSToolbar *)toolbar {
    return [self toolbarDefaultItemIdentifiers:toolbar];
}

#pragma mark 侧边栏

- (NSInteger)numberOfRowsInTableView:(NSTableView *)tableView { return 4; }

- (NSView *)tableView:(NSTableView *)tableView viewForTableColumn:(NSTableColumn *)tableColumn row:(NSInteger)row {
    NSTableCellView *cell = [tableView makeViewWithIdentifier:@"cell" owner:self];
    if (!cell) {
        cell = [[NSTableCellView alloc] initWithFrame:NSMakeRect(0, 0, 200, 30)];
        cell.identifier = @"cell";

        NSImageView *icon = [[NSImageView alloc] initWithFrame:NSZeroRect];
        icon.translatesAutoresizingMaskIntoConstraints = NO;
        icon.symbolConfiguration = [NSImageSymbolConfiguration configurationWithPointSize:15 weight:NSFontWeightRegular];

        NSTextField *text = [NSTextField labelWithString:@""];
        text.translatesAutoresizingMaskIntoConstraints = NO;
        text.font = [NSFont systemFontOfSize:13];

        [cell addSubview:icon];
        [cell addSubview:text];
        cell.imageView = icon;
        cell.textField = text;
        [NSLayoutConstraint activateConstraints:@[
            [icon.leadingAnchor constraintEqualToAnchor:cell.leadingAnchor constant:4.0],
            [icon.centerYAnchor constraintEqualToAnchor:cell.centerYAnchor],
            [icon.widthAnchor constraintEqualToConstant:18.0],
            [icon.heightAnchor constraintEqualToConstant:18.0],
            [text.leadingAnchor constraintEqualToAnchor:icon.trailingAnchor constant:7.0],
            [text.trailingAnchor constraintEqualToAnchor:cell.trailingAnchor constant:-4.0],
            [text.centerYAnchor constraintEqualToAnchor:cell.centerYAnchor]
        ]];
    }
    NSArray<NSString *> *titles = @[@"环形调制", @"插值", @"虚拟基音", @"节奏插值"];
    NSArray<NSString *> *symbols = @[@"waveform.path", @"chart.xyaxis.line", @"tuningfork", @"metronome"];
    NSInteger index = (row >= 0 && row < (NSInteger)titles.count) ? row : 0;
    cell.textField.stringValue = titles[index];
    cell.imageView.image = [NSImage imageWithSystemSymbolName:symbols[index]
                                      accessibilityDescription:nil];
    return cell;
}

- (void)tableViewSelectionDidChange:(NSNotification *)notification {
    NSInteger row = self.sidebarTable.selectedRow;
    if (row < 0) { return; }
    [self activateToolRow:row];
}

/* 菜单「工具」与侧边栏共用同一条切换路径 */
- (void)selectToolMenu:(NSMenuItem *)sender {
    NSInteger index = [sender.menu.itemArray indexOfObject:sender];
    if (index < 0 || index > 3) { return; }
    /* 只改选中项：真正的切换由 tableViewSelectionDidChange 统一处理 */
    [self.sidebarTable selectRowIndexes:[NSIndexSet indexSetWithIndex:index]
                   byExtendingSelection:NO];
}

- (void)activateToolRow:(NSInteger)row {
    NSInteger previousTool = self.activeTool;
    self.selectedRow = row;
    self.activeTool = (row >= 0 && row <= 3) ? row : 0;
    if (previousTool != self.activeTool) {
        /* 切换工具时停掉其它工具的声音，避免两路同时播放 */
        if (self.activeTool != 0) { [self evalJS:@"killLive()"]; }
        if (self.activeTool != 1) { [self evalInterpJS:@"window.InterpAPI && window.InterpAPI.stop()"]; }
        if (self.activeTool != 2) { [self evalVfJS:@"window.VirtualFundAPI && window.VirtualFundAPI.stop()"]; }
        if (self.activeTool != 3) { [self evalRhythmJS:@"window.RhythmAPI && window.RhythmAPI.stop()"]; }
    }
    [self applyToolVisibility];
    if (self.launchComplete) {
        [self rebuildTransportPanel];
        [self updatePanelReadout];
    }
    PoCLog(@"tool switched to %ld", (long)self.activeTool);
}

/* 让三个 web view 的可见性跟上 activeTool。
   注意：侧边栏的初始选中发生在 web view 创建【之前】，那时这些属性还是 nil，
   给 nil 赋 hidden 是空操作；所以创建完 web view 之后必须再调一次这个方法，
   否则「启动即打开非第一个工具」时旧页面会盖在上面。 */
- (void)applyToolVisibility {
    self.webView.hidden = (self.activeTool != 0);
    self.interpWebView.hidden = (self.activeTool != 1);
    self.vfWebView.hidden = (self.activeTool != 2);
    self.rhythmWebView.hidden = (self.activeTool != 3);
    self.placeholderView.hidden = YES;
    NSArray<NSString *> *toolTitles = @[@"环形调制", @"插值", @"虚拟基音", @"节奏插值"];
    if (self.activeTool >= 0 && self.activeTool <= 3) {
        self.window.title = toolTitles[self.activeTool];
    }
    PoCLog(@"tool visibility ring=%d interp=%d vf=%d rhythm=%d",
           !self.webView.hidden, !self.interpWebView.hidden,
           !self.vfWebView.hidden, !self.rhythmWebView.hidden);
}

#pragma mark 菜单

- (NSMenuItem *)addItem:(NSString *)title action:(SEL)action key:(NSString *)key target:(id)target to:(NSMenu *)menu {
    NSMenuItem *item = [menu addItemWithTitle:title action:action keyEquivalent:key ?: @""];
    item.target = target;
    return item;
}

- (void)buildMenu {
    NSMenu *mainMenu = [[NSMenu alloc] init];

    NSMenuItem *appItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:appItem];
    NSMenu *appMenu = [[NSMenu alloc] init];
    appItem.submenu = appMenu;
    [appMenu addItemWithTitle:[@"关于 " stringByAppendingString:kAppTitle]
                       action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"隐藏" action:@selector(hide:) keyEquivalent:@"h"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:[@"退出 " stringByAppendingString:kAppTitle]
                       action:@selector(terminate:) keyEquivalent:@"q"];

    NSMenuItem *fileItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:fileItem];
    NSMenu *fileMenu = [[NSMenu alloc] initWithTitle:@"文件"];
    fileItem.submenu = fileMenu;
    [self addItem:@"导出当前工具" action:@selector(exportCurrentTool:) key:@"e" target:self to:fileMenu];
    [self addItem:@"导出环形调制 SVG" action:@selector(exportSvg:) key:@"E" target:self to:fileMenu];
    [self addItem:@"导出环形调制 PNG" action:@selector(exportPng:) key:@"" target:self to:fileMenu];
    [self addItem:@"导出插值 MIDI" action:@selector(exportInterpMidi:) key:@"" target:self to:fileMenu];
    [fileMenu addItem:[NSMenuItem separatorItem]];
    [fileMenu addItemWithTitle:@"关闭窗口" action:@selector(performClose:) keyEquivalent:@"w"];

    NSMenuItem *editItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:editItem];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"编辑"];
    editItem.submenu = editMenu;
    [editMenu addItemWithTitle:@"撤销" action:@selector(undo:) keyEquivalent:@"z"];
    [editMenu addItemWithTitle:@"重做" action:@selector(redo:) keyEquivalent:@"Z"];
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItemWithTitle:@"剪切" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"拷贝" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"粘贴" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"全选" action:@selector(selectAll:) keyEquivalent:@"a"];

    NSMenuItem *viewItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:viewItem];
    NSMenu *viewMenu = [[NSMenu alloc] initWithTitle:@"显示"];
    viewItem.submenu = viewMenu;

    NSMenuItem *toolItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:toolItem];
    NSMenu *toolMenu = [[NSMenu alloc] initWithTitle:@"工具"];
    toolItem.submenu = toolMenu;
    [self addItem:@"环形调制" action:@selector(selectToolMenu:) key:@"1" target:self to:toolMenu];
    [self addItem:@"插值" action:@selector(selectToolMenu:) key:@"2" target:self to:toolMenu];
    [self addItem:@"虚拟基音" action:@selector(selectToolMenu:) key:@"3" target:self to:toolMenu];
    [self addItem:@"节奏插值" action:@selector(selectToolMenu:) key:@"4" target:self to:toolMenu];

    NSMenuItem *toggle = [viewMenu addItemWithTitle:@"显示 / 隐藏侧边栏"
                                             action:@selector(toggleSidebar:) keyEquivalent:@"s"];
    toggle.target = self.splitViewController;
    [self addItem:@"重新载入页面" action:@selector(reloadPage:) key:@"r" target:self to:viewMenu];
    [viewMenu addItem:[NSMenuItem separatorItem]];
    self.panelMenuItem = [self addItem:@"显示悬浮传输条"
                                action:@selector(togglePanel:)
                                   key:@"B" target:self to:viewMenu];
    self.panelMenuItem.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
    self.pinMenuItem = [self addItem:@"悬浮传输条置顶"
                              action:@selector(togglePin:)
                                 key:@"P" target:self to:viewMenu];
    self.pinMenuItem.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;

    NSMenu *materialMenu = [[NSMenu alloc] initWithTitle:@"面板材质"];
    self.glassMaterialMenuItem = [self addItem:@"玻璃（Liquid Glass）"
                                       action:@selector(useGlassMaterial:)
                                          key:@"" target:self to:materialMenu];
    self.frostedMaterialMenuItem = [self addItem:@"磨砂（behind-window）"
                                         action:@selector(useFrostedMaterial:)
                                            key:@"" target:self to:materialMenu];
    NSMenuItem *materialItem = [[NSMenuItem alloc] initWithTitle:@"面板材质" action:nil keyEquivalent:@""];
    materialItem.submenu = materialMenu;
    [viewMenu addItem:materialItem];
    [viewMenu addItem:[NSMenuItem separatorItem]];
    [self addItem:@"最小化主窗口" action:@selector(minimizeMainWindow:) key:@"m" target:self to:viewMenu].keyEquivalentModifierMask =
        NSEventModifierFlagCommand | NSEventModifierFlagOption;
    [self addItem:@"还原主窗口" action:@selector(restoreMainWindow:) key:@"r" target:self to:viewMenu].keyEquivalentModifierMask =
        NSEventModifierFlagCommand | NSEventModifierFlagOption;

    NSMenuItem *toolsItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:toolsItem];
    NSMenu *toolsMenu = [[NSMenu alloc] initWithTitle:@"工具"];
    toolsItem.submenu = toolsMenu;
    [self addItem:@"两音试听" action:@selector(playDyad:) key:@"" target:self to:toolsMenu];
    [self addItem:@"环形调制试听" action:@selector(playRing:) key:@"" target:self to:toolsMenu];
    [self addItem:@"和音 + 差音" action:@selector(playSumDiff:) key:@"" target:self to:toolsMenu];
    [self addItem:@"停止" action:@selector(stopAudio:) key:@"." target:self to:toolsMenu];
    [toolsMenu addItem:[NSMenuItem separatorItem]];
    [self addItem:@"插值：播放" action:@selector(playInterp:) key:@"" target:self to:toolsMenu];
    [self addItem:@"插值：停止" action:@selector(stopInterp:) key:@"" target:self to:toolsMenu];
    [self addItem:@"插值：导出 MIDI" action:@selector(exportInterpMidi:) key:@"" target:self to:toolsMenu];

    NSMenuItem *windowItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:windowItem];
    NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"窗口"];
    windowItem.submenu = windowMenu;
    [windowMenu addItemWithTitle:@"最小化" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    [windowMenu addItemWithTitle:@"缩放" action:@selector(performZoom:) keyEquivalent:@""];

    NSMenuItem *helpItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:helpItem];
    NSMenu *helpMenu = [[NSMenu alloc] initWithTitle:@"帮助"];
    helpItem.submenu = helpMenu;
    NSMenuItem *readme = [helpMenu addItemWithTitle:@"使用说明（README）" action:@selector(openReadme:) keyEquivalent:@"?"];
    readme.target = self;

    [NSApp setMainMenu:mainMenu];
    [self updatePanelButtons];
}

- (void)openReadme:(id)sender {
    NSURL *bundled = [[NSBundle mainBundle] URLForResource:@"README" withExtension:@"md"];
    if (bundled) {
        [[NSWorkspace sharedWorkspace] openURL:bundled];
        return;
    }
    NSString *path = [NSHomeDirectory() stringByAppendingPathComponent:
                      @"Documents/ChatGPT/论文paper/tools/mac-shell-poc/README.md"];
    if ([[NSFileManager defaultManager] fileExistsAtPath:path]) {
        [[NSWorkspace sharedWorkspace] openURL:[NSURL fileURLWithPath:path]];
    }
}

@end

#pragma mark - main

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
