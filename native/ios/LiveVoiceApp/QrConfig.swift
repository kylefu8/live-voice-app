import AVFoundation
import Foundation
import React
import UIKit

/// A small, app-local QR scanner.  It reads metadata from the camera and does
/// not create or save photo-library assets.
private final class QrScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  private let session = AVCaptureSession()
  private let sessionQueue = DispatchQueue(label: "com.livevoiceapp.qr-camera")
  private let locale: String
  private var previewLayer: AVCaptureVideoPreviewLayer!
  private var configured = false
  private var hasResult = false
  private var didReportFailure = false

  var onPayload: ((String) -> Void)?
  var onCancel: (() -> Void)?
  var onFailure: ((String) -> Void)?

  init(locale: String) {
    self.locale = locale == "en" ? "en" : "zh"
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .fullScreen
    modalTransitionStyle = .crossDissolve
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black

    previewLayer = AVCaptureVideoPreviewLayer(session: session)
    previewLayer.videoGravity = .resizeAspectFill
    view.layer.addSublayer(previewLayer)

    let topShade = UIView()
    topShade.backgroundColor = UIColor.black.withAlphaComponent(0.42)
    topShade.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(topShade)

    let title = UILabel()
    title.text = locale == "en"
      ? "Scan the encrypted configuration QR code"
      : "扫描加密配置二维码"
    title.textColor = .white
    title.font = .preferredFont(forTextStyle: .headline)
    title.textAlignment = .center
    title.numberOfLines = 0
    title.translatesAutoresizingMaskIntoConstraints = false
    topShade.addSubview(title)

    let cancelButton = UIButton(type: .system)
    cancelButton.setTitle(locale == "en" ? "Cancel" : "取消", for: .normal)
    cancelButton.setTitleColor(.white, for: .normal)
    cancelButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
    cancelButton.backgroundColor = UIColor.black.withAlphaComponent(0.55)
    cancelButton.layer.cornerRadius = 12
    cancelButton.contentEdgeInsets = UIEdgeInsets(top: 10, left: 18, bottom: 10, right: 18)
    cancelButton.addTarget(self, action: #selector(cancelPressed), for: .touchUpInside)
    cancelButton.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(cancelButton)

    let help = UILabel()
    help.text = locale == "en"
      ? "Place the QR code inside the frame"
      : "将二维码放入取景范围内"
    help.textColor = .white
    help.font = .preferredFont(forTextStyle: .subheadline)
    help.textAlignment = .center
    help.numberOfLines = 0
    help.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(help)

    NSLayoutConstraint.activate([
      topShade.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      topShade.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      topShade.topAnchor.constraint(equalTo: view.topAnchor),
      topShade.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 82),
      title.leadingAnchor.constraint(equalTo: topShade.leadingAnchor, constant: 24),
      title.trailingAnchor.constraint(equalTo: topShade.trailingAnchor, constant: -24),
      title.bottomAnchor.constraint(equalTo: topShade.bottomAnchor, constant: -16),
      cancelButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      cancelButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -26),
      help.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      help.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
      help.bottomAnchor.constraint(equalTo: cancelButton.topAnchor, constant: -18),
    ])

    sessionQueue.async { [weak self] in
      self?.configureSession()
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer?.frame = view.bounds
    if let connection = previewLayer?.connection, connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    sessionQueue.async { [weak self] in
      guard let self, self.configured, !self.session.isRunning else { return }
      self.session.startRunning()
    }
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    sessionQueue.async { [weak self] in
      guard let self, self.session.isRunning else { return }
      self.session.stopRunning()
    }
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    // A system dismissal or an interrupted presentation should settle the
    // pending promise.  Explicit cancellation and scan completion are already
    // guarded by QrConfig's single-operation state.
    if !hasResult && presentedViewController == nil {
      onCancel?()
    }
  }

  @objc private func cancelPressed() {
    onCancel?()
  }

  private func configureSession() {
    guard !configured, !didReportFailure else { return }
    guard let camera = AVCaptureDevice.default(for: .video) else {
      reportFailure("camera_unavailable")
      return
    }
    session.beginConfiguration()
    do {
      let input = try AVCaptureDeviceInput(device: camera)
      guard session.canAddInput(input) else {
        session.commitConfiguration()
        reportFailure("camera_unavailable")
        return
      }
      session.addInput(input)

      let output = AVCaptureMetadataOutput()
      guard session.canAddOutput(output) else {
        session.commitConfiguration()
        reportFailure("camera_unavailable")
        return
      }
      session.addOutput(output)
      output.setMetadataObjectsDelegate(self, queue: .main)
      output.metadataObjectTypes = [.qr]
      session.commitConfiguration()
      configured = true
      session.startRunning()
    } catch {
      session.commitConfiguration()
      reportFailure("camera_unavailable")
    }
  }

  private func reportFailure(_ code: String) {
    guard !didReportFailure else { return }
    didReportFailure = true
    DispatchQueue.main.async { [weak self] in
      self?.onFailure?(code)
    }
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard !hasResult,
          let metadata = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
          let value = metadata.stringValue,
          !value.isEmpty
    else { return }
    hasResult = true
    onPayload?(value)
  }
}

private final class QrOperation {
  enum Kind {
    case scan
    case decrypt
  }

  let kind: Kind
  let resolve: RCTPromiseResolveBlock
  let reject: RCTPromiseRejectBlock
  weak var scanner: QrScannerViewController?
  private let lock = NSLock()
  private var cancelled = false
  private var completed = false

  init(kind: Kind, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    self.kind = kind
    self.resolve = resolve
    self.reject = reject
  }

  func cancel() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !completed else { return false }
    cancelled = true
    completed = true
    return true
  }

  func isCancelled() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }

  func complete() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !completed && !cancelled else { return false }
    completed = true
    return true
  }
}

/// Native iOS bridge for QR scanning, LV1 decryption, and cancellation.
///
/// The JS layer owns review, connection probing, and secure persistence.  This
/// module owns camera permission, the scanner presentation, and the expensive
/// password operation; it never writes a QR payload, password, or decrypted
/// credential to disk or to a log.
@objc(QrConfig)
final class QrConfig: NSObject {
  private let stateLock = NSLock()
  private let cryptoQueue = DispatchQueue(
    label: "com.livevoiceapp.qr-crypto",
    qos: .userInitiated
  )
  private var activeOperation: QrOperation?
  private var backgroundObserver: NSObjectProtocol?

  override init() {
    super.init()
    backgroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.cancelActive()
    }
  }

  deinit {
    if let observer = backgroundObserver {
      NotificationCenter.default.removeObserver(observer)
    }
    cancelActive()
  }

  @objc static func requiresMainQueueSetup() -> Bool {
    true
  }

  @objc(scan:resolver:rejecter:)
  func scan(
    _ locale: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async { [weak self] in
      guard let self else {
        reject("camera_unavailable", nil, nil)
        return
      }
      guard UIApplication.shared.applicationState == .active else {
        reject("app_inactive", nil, nil)
        return
      }
      guard let operation = self.begin(kind: .scan, resolve: resolve, reject: reject) else {
        reject("qr_busy", nil, nil)
        return
      }

      switch AVCaptureDevice.authorizationStatus(for: .video) {
      case .authorized:
        self.presentScanner(for: operation, locale: locale)
      case .notDetermined:
        AVCaptureDevice.requestAccess(for: .video) { [weak self, weak operation] granted in
          DispatchQueue.main.async {
            guard let self, let operation,
                  self.isActive(operation), !operation.isCancelled()
            else { return }
            if granted {
              self.presentScanner(for: operation, locale: locale)
            } else {
              self.finish(operation, errorCode: "camera_permission")
            }
          }
        }
      case .denied, .restricted:
        self.finish(operation, errorCode: "camera_permission")
      @unknown default:
        self.finish(operation, errorCode: "camera_unavailable")
      }
    }
  }

  @objc(decrypt:passphrase:resolver:rejecter:)
  func decrypt(
    _ payload: String,
    passphrase: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let operation = begin(kind: .decrypt, resolve: resolve, reject: reject) else {
      reject("qr_busy", nil, nil)
      return
    }

    cryptoQueue.async { [weak self, weak operation] in
      guard let self, let operation else { return }
      do {
        let result = try QrConfigCrypto.decrypt(
          payload: payload,
          passphrase: passphrase,
          shouldCancel: { operation.isCancelled() }
        )
        // A cancellation can race with the completion of PBKDF2/AES.  Check
        // before converting the result to a bridge object and before resolving
        // so a late native result can never reach JS for persistence.
        guard !operation.isCancelled() else { return }
        self.finish(operation, value: result.bridgeValue())
      } catch let error as QrConfigCryptoError {
        if error.code == QrConfigCrypto.ErrorCode.cancelled || operation.isCancelled() {
          return
        }
        self.finish(operation, errorCode: error.code)
      } catch {
        if !operation.isCancelled() {
          self.finish(operation, errorCode: QrConfigCrypto.ErrorCode.decryptFailed)
        }
      }
    }
  }

  @objc(cancel:rejecter:)
  func cancel(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async { [weak self] in
      self?.cancelActive()
      resolve(nil)
    }
  }

  private func begin(
    kind: QrOperation.Kind,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) -> QrOperation? {
    stateLock.lock()
    defer { stateLock.unlock() }
    guard activeOperation == nil else { return nil }
    let operation = QrOperation(kind: kind, resolve: resolve, reject: reject)
    activeOperation = operation
    return operation
  }

  private func isActive(_ operation: QrOperation) -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return activeOperation === operation
  }

  private func clear(_ operation: QrOperation) {
    stateLock.lock()
    if activeOperation === operation {
      activeOperation = nil
    }
    stateLock.unlock()
  }

  private func presentScanner(for operation: QrOperation, locale: String) {
    guard isActive(operation), !operation.isCancelled(),
          let presenter = topViewController(), presenter.presentedViewController == nil
    else {
      finish(operation, errorCode: "camera_unavailable")
      return
    }

    let scanner = QrScannerViewController(locale: locale)
    operation.scanner = scanner
    scanner.onPayload = { [weak self, weak operation, weak scanner] payload in
      guard let self, let operation, let scanner else { return }
      self.finishScan(operation, scanner: scanner, payload: payload)
    }
    scanner.onCancel = { [weak self, weak operation] in
      guard let self, let operation else { return }
      self.finish(operation, errorCode: "qr_cancelled")
    }
    scanner.onFailure = { [weak self, weak operation] code in
      guard let self, let operation else { return }
      self.finish(operation, errorCode: code)
    }
    presenter.present(scanner, animated: true)
  }

  private func finishScan(_ operation: QrOperation, scanner: QrScannerViewController, payload: String) {
    do {
      try QrConfigCrypto.validatePayload(payload)
      finish(operation, value: payload, dismiss: scanner)
    } catch let error as QrConfigCryptoError {
      finish(operation, errorCode: error.code, dismiss: scanner)
    } catch {
      finish(operation, errorCode: QrConfigCrypto.ErrorCode.invalidPayload, dismiss: scanner)
    }
  }

  private func finish(
    _ operation: QrOperation,
    value: Any? = nil,
    errorCode: String? = nil,
    dismiss scanner: QrScannerViewController? = nil
  ) {
    guard operation.complete() else { return }
    clear(operation)
    let scannerToDismiss = scanner ?? operation.scanner
    if let scannerToDismiss, scannerToDismiss.presentingViewController != nil {
      scannerToDismiss.dismiss(animated: true)
    }
    if let errorCode {
      operation.reject(errorCode, nil, nil)
    } else {
      operation.resolve(value)
    }
  }

  private func cancelActive() {
    stateLock.lock()
    let operation = activeOperation
    activeOperation = nil
    stateLock.unlock()

    guard let operation, operation.cancel() else { return }
    if let scanner = operation.scanner, scanner.presentingViewController != nil {
      scanner.dismiss(animated: true)
    }
    operation.reject("qr_cancelled", nil, nil)
  }

  private func topViewController() -> UIViewController? {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
    guard let root = windows.first(where: { $0.isKeyWindow })?.rootViewController else {
      return nil
    }
    return topViewController(from: root)
  }

  private func topViewController(from controller: UIViewController) -> UIViewController {
    if let presented = controller.presentedViewController {
      return topViewController(from: presented)
    }
    if let navigation = controller as? UINavigationController, let visible = navigation.visibleViewController {
      return topViewController(from: visible)
    }
    if let tab = controller as? UITabBarController, let selected = tab.selectedViewController {
      return topViewController(from: selected)
    }
    return controller
  }
}
