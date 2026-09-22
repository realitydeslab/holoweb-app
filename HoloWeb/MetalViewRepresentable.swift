 import SwiftUI
 import MetalKit
 import ARKit

extension MTKView : @MainActor RenderDestinationProvider {
}

struct MetalViewRepresentable: UIViewRepresentable {
    @Environment(HoloWebState.self) private var state
    
     func makeUIView(context: Context) -> MTKView {
         let mtkView = MTKView(frame: UIScreen.main.bounds, device: MTLCreateSystemDefaultDevice())
         mtkView.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
         mtkView.backgroundColor = .clear
         mtkView.isPaused = false
         mtkView.isOpaque = false

         // Setup AR session
         let renderer = Renderer(session: state.session, metalDevice: mtkView.device!, renderDestination: mtkView)
         context.coordinator.renderer = renderer
         mtkView.delegate = context.coordinator
         renderer.drawRectResized(size: mtkView.bounds.size)
         
         return mtkView
     }
    
     func updateUIView(_ uiView: MTKView, context: Context) {
         context.coordinator.renderer?.drawsCameraImage = state.mode == .mono
     }
    
     func makeCoordinator() -> Coordinator {
         Coordinator(self)
     }
    
     class Coordinator: NSObject, MTKViewDelegate {
         var parent: MetalViewRepresentable
         var renderer: Renderer?
         
         init(_ parent: MetalViewRepresentable) {
             self.parent = parent
        }
         
         func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
             renderer?.drawRectResized(size: size)
         }
         
         func draw(in view: MTKView) {
             if let orientation = view.window?.windowScene?.effectiveGeometry.interfaceOrientation {
                 renderer?.orientation = orientation
             }
             renderer?.update()
         }
        
     }
 } 
