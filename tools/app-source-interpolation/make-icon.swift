import Foundation
import AppKit
import CoreGraphics
import ImageIO

let size = 1024
guard let ctx = CGContext(data: nil, width: size, height: size,
                          bitsPerComponent: 8, bytesPerRow: 0,
                          space: CGColorSpaceCreateDeviceRGB(),
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    fatalError("cannot create context")
}

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    let r = CGFloat((hex >> 16) & 0xFF) / 255
    let g = CGFloat((hex >> 8) & 0xFF) / 255
    let b = CGFloat(hex & 0xFF) / 255
    return CGColor(red: r, green: g, blue: b, alpha: alpha)
}

// 深色圆角底
let bgPath = CGPath(roundedRect: CGRect(x: 0, y: 0, width: size, height: size),
                    cornerWidth: 228, cornerHeight: 228, transform: nil)
ctx.addPath(bgPath)
ctx.clip()
let bgGradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                            colors: [color(0x1D1D1F), color(0x3A3A3E)] as CFArray,
                            locations: [0, 1])!
ctx.drawLinearGradient(bgGradient,
                       start: CGPoint(x: 0, y: size),
                       end: CGPoint(x: 0, y: 0),
                       options: [])

// 五线谱
ctx.setLineCap(.round)
ctx.setStrokeColor(color(0x8E8E96, 0.9))
ctx.setLineWidth(13)
for i in 0..<5 {
    let y = CGFloat(360 + i * 70)
    ctx.move(to: CGPoint(x: 150, y: y))
    ctx.addLine(to: CGPoint(x: 874, y: y))
}
ctx.strokePath()

// 插值曲线：单段三次贝塞尔，逐段上色成蓝→橙
let p0 = CGPoint(x: 170, y: 706)
let c1 = CGPoint(x: 380, y: 706)
let c2 = CGPoint(x: 650, y: 336)
let p3 = CGPoint(x: 862, y: 336)

func bezier(_ t: CGFloat) -> CGPoint {
    let mt = 1 - t
    let a = mt * mt * mt
    let b = 3 * mt * mt * t
    let c = 3 * mt * t * t
    let d = t * t * t
    return CGPoint(x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
                   y: a * p0.y + b * c1.y + c * c2.y + d * p3.y)
}

func mix(_ a: (CGFloat, CGFloat, CGFloat), _ b: (CGFloat, CGFloat, CGFloat), _ t: CGFloat) -> CGColor {
    return CGColor(red: a.0 + (b.0 - a.0) * t,
                   green: a.1 + (b.1 - a.1) * t,
                   blue: a.2 + (b.2 - a.2) * t,
                   alpha: 1)
}

let blue: (CGFloat, CGFloat, CGFloat) = (10 / 255, 108 / 255, 1)
let orange: (CGFloat, CGFloat, CGFloat) = (210 / 255, 105 / 255, 30 / 255)
ctx.setLineCap(.round)
ctx.setLineWidth(36)
let steps = 80
for i in 0..<steps {
    let t0 = CGFloat(i) / CGFloat(steps)
    let t1 = CGFloat(i + 1) / CGFloat(steps)
    ctx.setStrokeColor(mix(blue, orange, (t0 + t1) / 2))
    ctx.move(to: bezier(t0))
    ctx.addLine(to: bezier(t1))
    ctx.strokePath()
}

// 采样点
for t in [CGFloat(0), 0.25, 0.5, 0.75, 1.0] {
    let p = bezier(t)
    ctx.setFillColor(color(0xFFFFFF))
    ctx.fillEllipse(in: CGRect(x: p.x - 22, y: p.y - 22, width: 44, height: 44))
}

guard let image = ctx.makeImage() else { fatalError("cannot make image") }
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/icon1024.png"
let url = URL(fileURLWithPath: out) as CFURL
guard let dest = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil) else {
    fatalError("cannot create destination")
}
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
print(out)
