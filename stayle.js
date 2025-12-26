// Data dan inisialisasi
document.addEventListener("DOMContentLoaded", function () {
  // Inisialisasi data
  initTransaction();

  // Event listeners untuk metode pembayaran
  const methodCards = document.querySelectorAll(".method-card");
  methodCards.forEach((card) => {
    card.addEventListener("click", function () {
      // Hapus kelas selected dari semua kartu
      methodCards.forEach((c) => c.classList.remove("selected"));

      // Tambahkan kelas selected ke kartu yang diklik
      this.classList.add("selected");

      // Tampilkan form yang sesuai
      const method = this.getAttribute("data-method");
      showPaymentForm(method);

      // Update metode di struk
      updateReceiptMethod(method);

      // Jika berpindah dari mode scan, hentikan kamera bila aktif
      try {
        if (method !== "scan" && typeof stopCameraScan === "function") {
          stopCameraScan();
        }
      } catch (e) {
        // ignore if function not available
      }
    });
  });

  // Event listener untuk input jumlah pembayaran
  const amountInput = document.getElementById("amount");
  amountInput.addEventListener("input", function () {
    updateReceiptAmount(this.value);
  });

  // Event listener untuk tombol proses pembayaran
  const processBtn = document.getElementById("process-payment");
  processBtn.addEventListener("click", processPayment);

  // Format input kartu kredit
  const cardNumberInput = document.getElementById("card-number");
  cardNumberInput.addEventListener("input", formatCardNumber);

  const expiryDateInput = document.getElementById("expiry-date");
  expiryDateInput.addEventListener("input", formatExpiryDate);

  // Scan / Barcode feature setup
  const scanQrBtn = document.getElementById("scan-qr-btn");
  const scanBarcodeBtn = document.getElementById("scan-barcode-btn");
  const scanVideo = document.getElementById("scan-video");
  window.scanData = ""; // global scanned value
  let scanMode = "qr";
  let cameraStream = null;
  let cameraScanning = false;
  let cameraFrameId = null;
  let qrDetectionFrameId = null; // for QR detection while Quagga is running
  let barcodeFrameId = null; // fallback frame loop for barcode decoding

  function updateScanButtons() {
    const scanImage = document.getElementById("scan-image");
    const qrActive = scanImage && scanImage.style.display === "block";

    if (scanQrBtn) {
      if (qrActive) {
        scanQrBtn.classList.add("active");
        scanQrBtn.textContent = "Sembunyikan QR";
      } else {
        scanQrBtn.classList.remove("active");
        scanQrBtn.textContent = "Pindai QR";
      }
    }

    if (scanBarcodeBtn) {
      if (cameraScanning && scanMode === "barcode") {
        scanBarcodeBtn.classList.add("active");
        scanBarcodeBtn.textContent = "Hentikan Kamera";
      } else {
        scanBarcodeBtn.classList.remove("active");
        scanBarcodeBtn.textContent = "Pindai Barcode";
      }
    }
  }

  if (scanQrBtn) {
    scanQrBtn.addEventListener("click", function () {
      // Instead of camera scanning, QR will show an image tugass.png
      // If image already visible, hide it
      const scanImage = document.getElementById("scan-image");
      const scanVideoEl = document.getElementById("scan-video");
      if (scanImage && scanImage.style.display === "block") {
        // hide image
        scanImage.style.display = "none";
        setScanResult("");
        showNotification("Gambar disembunyikan", "info");
      } else {
        // stop camera if running
        if (cameraScanning) stopCameraScan();
        // hide any existing camera UI
        if (scanVideoEl) scanVideoEl.style.display = "none";
        // show image
        if (scanImage) scanImage.style.display = "block";
        // set scan data to image filename
        showNotification("Menampilkan QR", "info");
      }
      // update buttons visual state
      updateScanButtons();
    });
  }

  if (scanBarcodeBtn) {
    scanBarcodeBtn.addEventListener("click", function () {
      // hide QR image if visible
      const scanImage = document.getElementById("scan-image");
      if (scanImage && scanImage.style.display === "block") {
        scanImage.style.display = "none";
        setScanResult("");
      }

      // toggle camera for Barcode mode
      if (cameraScanning && scanMode === "barcode") {
        stopCameraScan();
      } else {
        scanMode = "barcode";
        showNotification("Mode scan: Barcode", "info");
        if (cameraScanning) {
          stopCameraScan();
          startCameraScan();
        } else {
          startCameraScan();
        }
      }
      updateScanButtons();
    });
  }

  function startCameraScan() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showNotification("Kamera tidak didukung pada browser ini", "error");
      return;
    }

    if (scanMode === "qr") {
      const constraints = { video: { facingMode: "environment" } };
      navigator.mediaDevices
        .getUserMedia(constraints)
        .then((stream) => {
          cameraStream = stream;
          scanVideo.srcObject = stream;
          scanVideo.style.display = "block";
          cameraScanning = true;
          updateScanButtons();

          startQRCodeLoop();
        })
        .catch((err) => {
          console.error(err);
          showNotification("Gagal mengakses kamera: " + err.message, "error");
        });
    } else {
      // For barcode scanning, use getUserMedia + frame decoding loop so camera reliably detects barcodes
      if (scanVideo) scanVideo.style.display = "block";
      cameraScanning = true;
      updateScanButtons();

      // Stop any active Quagga instance to avoid camera conflicts
      if (typeof Quagga !== "undefined" && Quagga.stop) {
        try {
          Quagga.stop();
        } catch (e) {
          // ignore
        }
      }

      // Start camera and frame loop for barcode decoding
      startBarcodeFrameLoop();
    }
  }

  function stopCameraScan() {
    scanVideo.style.display = "none";

    if (cameraFrameId) {
      cancelAnimationFrame(cameraFrameId);
      cameraFrameId = null;
    }

    if (qrDetectionFrameId) {
      cancelAnimationFrame(qrDetectionFrameId);
      qrDetectionFrameId = null;
    }

    if (barcodeFrameId) {
      cancelAnimationFrame(barcodeFrameId);
      barcodeFrameId = null;
    }

    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }

    if (typeof Quagga !== "undefined" && Quagga.stop) {
      try {
        Quagga.stop();
      } catch (e) {
        // ignore
      }
    }

    cameraScanning = false;
    updateScanButtons();
  }

  function startQRCodeLoop() {
    const canvas = document.getElementById("scan-canvas");
    const ctx = canvas.getContext("2d");

    function loop() {
      if (!cameraScanning || !scanVideo.videoWidth) {
        cameraFrameId = requestAnimationFrame(loop);
        return;
      }

      canvas.width = scanVideo.videoWidth;
      canvas.height = scanVideo.videoHeight;
      ctx.drawImage(scanVideo, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (typeof jsQR !== "undefined") {
        const code = jsQR(imageData.data, canvas.width, canvas.height);
        if (code && code.data) {
          setScanResult(code.data);
          showNotification("QR berhasil dipindai", "success");
          stopCameraScan();
          return;
        }
      }

      cameraFrameId = requestAnimationFrame(loop);
    }

    cameraFrameId = requestAnimationFrame(loop);
  }

  function startQuaggaLive() {
    if (typeof Quagga === "undefined") {
      showNotification(
        "Quagga tidak tersedia untuk pemindaian barcode langsung — menggunakan fallback frame decoding",
        "info"
      );
      // fallback to frame-based decoding
      startBarcodeFrameLoop();
      return;
    }

    // Use a container element (parent of the native video) as Quagga target
    const targetEl =
      scanVideo && scanVideo.parentElement
        ? scanVideo.parentElement
        : document.body;

    Quagga.init(
      {
        inputStream: {
          type: "LiveStream",
          target: targetEl,
          constraints: { facingMode: "environment" },
          singleChannel: false,
        },
        decoder: {
          readers: [
            "code_128_reader",
            "ean_reader",
            "ean_8_reader",
            "upc_reader",
            "upc_e_reader",
            "code_39_reader",
            "codabar_reader",
          ],
        },
        locate: true,
      },
      function (err) {
        if (err) {
          console.error(err);
          cameraScanning = false;
          updateScanButtons();
          showNotification(
            "Gagal memulai Quagga: " + err.message + " — menggunakan fallback",
            "info"
          );
          startBarcodeFrameLoop();
          return;
        }

        try {
          Quagga.start();
        } catch (e) {
          console.error(e);
          cameraScanning = false;
          updateScanButtons();
          showNotification(
            "Gagal memulai pemindaian barcode: " +
              e.message +
              " — menggunakan fallback",
            "info"
          );
          startBarcodeFrameLoop();
          return;
        }

        // Also scan for QR codes from the camera frames while Quagga runs
        const canvas = document.getElementById("scan-canvas");
        const ctx = canvas.getContext("2d");
        function qrLoop() {
          if (!cameraScanning) {
            qrDetectionFrameId = requestAnimationFrame(qrLoop);
            return;
          }

          let width = 0,
            height = 0;
          // Prefer the video element Quagga injected in the target container; fallback to native scanVideo
          let srcVideo = null;
          if (targetEl) {
            srcVideo = targetEl.querySelector("video") || scanVideo;
          } else {
            srcVideo = scanVideo;
          }

          if (srcVideo && srcVideo.videoWidth) {
            width = srcVideo.videoWidth;
            height = srcVideo.videoHeight;
            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(srcVideo, 0, 0, width, height);
          }

          if (typeof jsQR !== "undefined" && width && height) {
            const imageData = ctx.getImageData(0, 0, width, height);
            const code = jsQR(imageData.data, width, height);
            if (code && code.data) {
              setScanResult(code.data);
              showNotification("QR berhasil dipindai", "success");
              Quagga.offDetected();
              stopCameraScan();
              return;
            }
          }

          qrDetectionFrameId = requestAnimationFrame(qrLoop);
        }
        qrDetectionFrameId = requestAnimationFrame(qrLoop);

        Quagga.onDetected(function (data) {
          if (data && data.codeResult && data.codeResult.code) {
            setScanResult(data.codeResult.code);
            showNotification("Barcode berhasil dipindai", "success");
            Quagga.offDetected();
            stopCameraScan();
          }
        });

        // If Quagga didn't produce a visible preview element, ensure the native video is visible as fallback
        if (scanVideo && scanVideo.style.display === "none") {
          scanVideo.style.display = "block";
        }
      }
    );
  }

  // Barcode frame decoding loop: request getUserMedia and decode frames periodically using Quagga.decodeSingle
  function startBarcodeFrameLoop() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showNotification("Kamera tidak didukung pada browser ini", "error");
      cameraScanning = false;
      updateScanButtons();
      return;
    }

    const constraints = { video: { facingMode: "environment" } };
    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        // attach stream and make sure preview visible
        cameraStream = stream;
        scanVideo.srcObject = stream;
        scanVideo.style.display = "block";
        cameraScanning = true;
        updateScanButtons();

        const canvas = document.getElementById("scan-canvas");
        const ctx = canvas.getContext("2d");

        // throttle decode attempts (ms)
        const DECODE_INTERVAL = 400;
        let lastDecodeTime = 0;

        function loop() {
          if (!cameraScanning || !scanVideo.videoWidth) {
            barcodeFrameId = requestAnimationFrame(loop);
            return;
          }

          const now = Date.now();
          canvas.width = scanVideo.videoWidth;
          canvas.height = scanVideo.videoHeight;
          ctx.drawImage(scanVideo, 0, 0, canvas.width, canvas.height);

          if (now - lastDecodeTime >= DECODE_INTERVAL) {
            lastDecodeTime = now;

            // prefer Quagga.decodeSingle if available
            if (typeof Quagga !== "undefined" && Quagga.decodeSingle) {
              try {
                const dataUrl = canvas.toDataURL("image/png");
                Quagga.decodeSingle(
                  {
                    src: dataUrl,
                    numOfWorkers: 0,
                    inputStream: { size: 800 },
                    decoder: {
                      readers: [
                        "code_128_reader",
                        "ean_reader",
                        "ean_8_reader",
                        "upc_reader",
                        "upc_e_reader",
                        "code_39_reader",
                        "codabar_reader",
                      ],
                    },
                  },
                  function (result) {
                    if (result && result.codeResult && result.codeResult.code) {
                      setScanResult(result.codeResult.code);
                      showNotification("Barcode berhasil dipindai", "success");
                      stopCameraScan();
                      return;
                    }
                  }
                );
              } catch (e) {
                // ignore decode exceptions
              }
            } else {
              // If Quagga not available, try QR detection as fallback (some barcodes might be QR)
              if (typeof jsQR !== "undefined") {
                try {
                  const imageData = ctx.getImageData(
                    0,
                    0,
                    canvas.width,
                    canvas.height
                  );
                  const code = jsQR(
                    imageData.data,
                    canvas.width,
                    canvas.height
                  );
                  if (code && code.data) {
                    setScanResult(code.data);
                    showNotification(
                      "QR berhasil dipindai (fallback)",
                      "success"
                    );
                    stopCameraScan();
                    return;
                  }
                } catch (e) {
                  // ignore
                }
              }
            }
          }

          barcodeFrameId = requestAnimationFrame(loop);
        }

        barcodeFrameId = requestAnimationFrame(loop);
      })
      .catch((err) => {
        console.error(err);
        showNotification("Gagal mengakses kamera: " + err.message, "error");
      });
  }

  // Cleanup camera on page unload
  window.addEventListener("beforeunload", function () {
    stopCameraScan();
  });

  // Inisialisasi riwayat transaksi
  initTransactionHistory();
});

// Fungsi untuk inisialisasi transaksi
function initTransaction() {
  // Set tanggal dan waktu saat ini
  const now = new Date();
  const dateStr = now.toLocaleDateString("id-ID");
  const timeStr = now.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  document.getElementById("transaction-date").textContent = dateStr;
  document.getElementById("transaction-time").textContent = timeStr;

  // Generate ID transaksi acak
  const transactionId = "TRX-" + Math.floor(100000 + Math.random() * 900000);
  document.getElementById("transaction-id").textContent = transactionId;

  // Reset scan data display
  window.scanData = "";
  const scanCodeEl = document.getElementById("scan-code");
  if (scanCodeEl) scanCodeEl.textContent = "-";
  const scanResultEl = document.getElementById("scan-result");
  if (scanResultEl) scanResultEl.textContent = "-";
}

// Fungsi untuk menampilkan form pembayaran yang sesuai
function showPaymentForm(method) {
  // Sembunyikan semua form
  const forms = document.querySelectorAll(".method-form");
  forms.forEach((form) => {
    form.classList.remove("active");
  });

  // Tampilkan form yang dipilih
  const selectedForm = document.getElementById(`${method}-form`);
  selectedForm.classList.add("active");

  // Update metode pembayaran di struk
  updateReceiptMethod(method);
}

// Fungsi untuk memperbarui metode pembayaran di struk
function updateReceiptMethod(method) {
  const methodNames = {
    "credit-card": "Kartu Kredit",
    "bank-transfer": "Transfer Bank",
    "e-wallet": "E-Wallet",
    scan: "Scan / Barcode",
    cash: "Tunai",
  };

  document.getElementById("transaction-method").textContent =
    methodNames[method] || method;
}

// Fungsi untuk memperbarui jumlah pembayaran di struk
function updateReceiptAmount(amount) {
  if (!amount || amount <= 0) {
    document.getElementById("transaction-amount").textContent = "Rp 0";
    return;
  }

  const formattedAmount = new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  }).format(amount);

  document.getElementById("transaction-amount").textContent = formattedAmount;
}

// Fungsi untuk memformat nomor kartu kredit
function formatCardNumber(e) {
  let value = e.target.value.replace(/\s+/g, "").replace(/[^0-9]/gi, "");
  let formattedValue = "";

  for (let i = 0; i < value.length && i < 16; i++) {
    if (i > 0 && i % 4 === 0) {
      formattedValue += " ";
    }
    formattedValue += value[i];
  }

  e.target.value = formattedValue;
}

// Fungsi untuk memformat tanggal kedaluwarsa kartu
function formatExpiryDate(e) {
  let value = e.target.value.replace(/\s+/g, "").replace(/[^0-9]/gi, "");

  if (value.length >= 2) {
    value = value.substring(0, 2) + "/" + value.substring(2, 4);
  }

  e.target.value = value;
}

// Scan / decode helpers
function decodeScanFile(file, mode) {
  const reader = new FileReader();
  reader.onload = function (e) {
    const img = new Image();
    img.onload = function () {
      const canvas = document.getElementById("scan-canvas");
      if (!canvas) {
        showNotification("Elemen canvas untuk scan tidak ditemukan", "error");
        return;
      }
      const ctx = canvas.getContext("2d");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      if (mode === "qr") {
        if (typeof jsQR !== "undefined") {
          const code = jsQR(imageData.data, canvas.width, canvas.height);
          if (code && code.data) {
            setScanResult(code.data);
            showNotification("QR berhasil dipindai", "success");
            return;
          }
        }
        // fallback to barcode
        tryBarcodeDecodeUsingQuagga(file, function (found) {
          if (!found) {
            showNotification("Tidak ditemukan kode pada gambar", "error");
          }
        });
      } else {
        // barcode mode
        tryBarcodeDecodeUsingQuagga(file, function (found) {
          if (!found) {
            // fallback to QR
            if (typeof jsQR !== "undefined") {
              const code = jsQR(imageData.data, canvas.width, canvas.height);
              if (code && code.data) {
                setScanResult(code.data);
                showNotification("QR berhasil dipindai", "success");
                return;
              }
            }
            showNotification("Tidak ditemukan kode pada gambar", "error");
          }
        });
      }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function tryBarcodeDecodeUsingQuagga(file, cb) {
  if (typeof Quagga === "undefined") {
    if (cb) cb(false);
    return;
  }
  Quagga.decodeSingle(
    {
      src: URL.createObjectURL(file),
      numOfWorkers: 0,
      inputStream: { size: 800 },
      decoder: {
        readers: [
          "code_128_reader",
          "ean_reader",
          "ean_8_reader",
          "upc_reader",
        ],
      },
    },
    function (result) {
      if (result && result.codeResult && result.codeResult.code) {
        setScanResult(result.codeResult.code);
        if (cb) cb(true);
      } else {
        if (cb) cb(false);
      }
    }
  );
}

function setScanResult(value) {
  window.scanData = value || "";
  const resultEl = document.getElementById("scan-result");
  if (resultEl) resultEl.textContent = value || "-";
  const scanCodeEl = document.getElementById("scan-code");
  if (scanCodeEl) scanCodeEl.textContent = value || "-";
}

// Fungsi untuk memproses pembayaran
function processPayment() {
  // Validasi input
  const amountInput = document.getElementById("amount");
  const amount = parseFloat(amountInput.value);

  if (!amount || amount < 1000) {
    showNotification("Jumlah pembayaran minimal Rp 1.000", "error");
    amountInput.focus();
    return;
  }

  // Dapatkan metode pembayaran yang dipilih
  const selectedMethod = document
    .querySelector(".method-card.selected")
    .getAttribute("data-method");

  // Validasi berdasarkan metode pembayaran
  let isValid = true;
  let errorMessage = "";

  switch (selectedMethod) {
    case "credit-card":
      const cardNumber = document.getElementById("card-number").value;
      const expiryDate = document.getElementById("expiry-date").value;
      const cvv = document.getElementById("cvv").value;
      const cardName = document.getElementById("card-name").value;

      if (!cardNumber || cardNumber.replace(/\s/g, "").length !== 16) {
        isValid = false;
        errorMessage = "Nomor kartu kredit harus 16 digit";
      } else if (!expiryDate || !/^\d{2}\/\d{2}$/.test(expiryDate)) {
        isValid = false;
        errorMessage = "Format tanggal kedaluwarsa tidak valid (MM/YY)";
      } else if (!cvv || cvv.length !== 3) {
        isValid = false;
        errorMessage = "CVV harus 3 digit";
      } else if (!cardName) {
        isValid = false;
        errorMessage = "Nama di kartu harus diisi";
      }
      break;

    case "scan":
      // Pastikan sudah melakukan scan
      if (!window.scanData || window.scanData.trim() === "") {
        isValid = false;
        errorMessage = "Silakan lakukan scan QR/Barcode terlebih dahulu";
      }
      break;

    case "bank-transfer":
      const virtualAccount = document
        .getElementById("virtual-account")
        .value.trim();
      // Minimal 6 karakter (angka/spasi) untuk nomor VA — sesuaikan bila perlu
      if (!virtualAccount || virtualAccount.replace(/\s/g, "").length < 6) {
        isValid = false;
        errorMessage = "Nomor rekening virtual tidak valid";
      }
      break;

    case "e-wallet":
      const phoneNumber = document.getElementById("phone-number").value;
      if (!phoneNumber || phoneNumber.length < 10) {
        isValid = false;
        errorMessage = "Nomor telepon tidak valid";
      }
      break;

    case "cash":
      // Tidak ada validasi khusus untuk pembayaran tunai
      break;
  }

  if (!isValid) {
    showNotification(errorMessage, "error");
    return;
  }

  // Simulasikan proses pembayaran
  showNotification("Memproses pembayaran...", "info");

  // Ubah teks tombol
  const processBtn = document.getElementById("process-payment");
  const originalText = processBtn.innerHTML;
  processBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memproses...';
  processBtn.disabled = true;

  // Simulasikan delay jaringan
  setTimeout(() => {
    // 80% kemungkinan berhasil, 20% gagal (untuk simulasi)
    const isSuccess = Math.random() < 0.8;

    if (isSuccess) {
      // Pembayaran berhasil
      updateTransactionStatus("success");
      showNotification("Pembayaran berhasil!", "success");

      // Tambahkan ke riwayat transaksi
      addToTransactionHistory(amount, selectedMethod, true);
    } else {
      // Pembayaran gagal
      updateTransactionStatus("failed");
      showNotification("Pembayaran gagal. Silakan coba lagi.", "error");

      // Tambahkan ke riwayat transaksi
      addToTransactionHistory(amount, selectedMethod, false);
    }

    // Reset tombol
    processBtn.innerHTML = originalText;
    processBtn.disabled = false;

    // Generate ID transaksi baru
    const transactionId = "TRX-" + Math.floor(100000 + Math.random() * 900000);
    document.getElementById("transaction-id").textContent = transactionId;
  }, 2000);
}

// Fungsi untuk memperbarui status transaksi di struk
function updateTransactionStatus(status) {
  const statusElement = document.getElementById("transaction-status");
  statusElement.textContent =
    status === "success"
      ? "Berhasil"
      : status === "failed"
      ? "Gagal"
      : "Menunggu";

  // Hapus semua kelas status
  statusElement.classList.remove("pending", "success", "failed");

  // Tambahkan kelas yang sesuai
  if (status === "success") {
    statusElement.classList.add("success");
  } else if (status === "failed") {
    statusElement.classList.add("failed");
  } else {
    statusElement.classList.add("pending");
  }
}

// Fungsi untuk menampilkan notifikasi
function showNotification(message, type = "info") {
  const notification = document.getElementById("notification");
  const messageElement = document.getElementById("notification-message");
  const iconElement = notification.querySelector("i");

  // Set pesan
  messageElement.textContent = message;

  // Atur ikon berdasarkan tipe
  if (type === "success") {
    iconElement.className = "fas fa-check-circle";
    iconElement.style.color = "#4cd964";
  } else if (type === "error") {
    iconElement.className = "fas fa-exclamation-circle";
    iconElement.style.color = "#ff3b30";
  } else {
    iconElement.className = "fas fa-info-circle";
    iconElement.style.color = "#3498db";
  }

  // Tampilkan notifikasi
  notification.style.display = "block";

  // Sembunyikan notifikasi setelah 5 detik
  setTimeout(() => {
    notification.style.display = "none";
  }, 5000);
}

// Fungsi untuk inisialisasi riwayat transaksi
function initTransactionHistory() {
  // Data riwayat transaksi contoh
  const sampleHistory = [
    {
      id: "TRX-001",
      amount: 75000,
      method: "Kartu Kredit",
      date: "01/01/2023 09:15",
      status: "success",
    },
    {
      id: "TRX-002",
      amount: 120000,
      method: "E-Wallet",
      date: "31/12/2022 14:30",
      status: "success",
    },
    {
      id: "TRX-003",
      amount: 50000,
      method: "Transfer Bank",
      date: "30/12/2022 11:45",
      status: "failed",
    },
  ];

  // Tambahkan riwayat contoh
  sampleHistory.forEach((transaction) => {
    addToTransactionHistory(
      transaction.amount,
      transaction.method,
      transaction.status === "success",
      transaction.date,
      transaction.id
    );
  });
}

// Fungsi untuk menambahkan transaksi ke riwayat
function addToTransactionHistory(
  amount,
  method,
  isSuccess,
  customDate = null,
  customId = null
) {
  const historyList = document.querySelector(".history-list");

  // Format jumlah
  const formattedAmount = new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  }).format(amount);

  // Format nama metode
  const methodNames = {
    "credit-card": "Kartu Kredit",
    "bank-transfer": "Transfer Bank",
    "e-wallet": "E-Wallet",
    scan: "Scan / Barcode",
    cash: "Tunai",
  };

  const methodName =
    method === "scan"
      ? `Scan • ${window.scanData || "-"}`
      : methodNames[method] || method;

  // Buat ID transaksi
  const transactionId =
    customId || "TRX-" + Math.floor(1000 + Math.random() * 9000);

  // Buat tanggal
  const now = new Date();
  const dateStr =
    customDate ||
    now.toLocaleDateString("id-ID") +
      " " +
      now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

  // Buat elemen riwayat
  const historyItem = document.createElement("div");
  historyItem.className = `history-item ${isSuccess ? "success" : "failed"}`;

  historyItem.innerHTML = `
        <div class="history-details">
            <h4>${transactionId}</h4>
            <p>${methodName} • ${dateStr}</p>
        </div>
        <div class="history-amount">${formattedAmount}</div>
    `;

  // Tambahkan ke awal daftar
  historyList.insertBefore(historyItem, historyList.firstChild);

  // Batasi jumlah riwayat menjadi 10
  const items = historyList.querySelectorAll(".history-item");
  if (items.length > 10) {
    historyList.removeChild(items[items.length - 1]);
  }
}
