let mediaRecorder;
let audioChunks = [];
let isRecording = false;

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusBox = document.getElementById("status");
const summarySection = document.getElementById("summarySection");
const summaryContent = document.getElementById("summaryContent");

const BACKEND_URL = "http://localhost:5000/upload"; // Flask endpoint

// Utility: update status UI
function updateStatus(state, mainText, detailText) {
  statusBox.className = `status ${state}`;
  statusBox.querySelector(".status-text").textContent = mainText;
  statusBox.querySelector(".status-detail").textContent = detailText;
}

// Utility: safely stop all tracks
function stopStream(stream) {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
}

// Start recording logic
startBtn.addEventListener("click", async () => {
  if (isRecording) {
    console.log("Already recording...");
    return;
  }

  audioChunks = [];
  let stream = null;

  try {
    // Check for mic permission
    const permissions = await navigator.permissions.query({ name: "microphone" });
    if (permissions.state === "denied") {
      console.warn("Microphone permission denied. Trying tab capture...");
    }

    // Try microphone access first
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("✅ Microphone access granted.");
    } catch (err) {
      console.warn("⚠️ Mic capture failed, switching to tab audio:", err);
      // Fall back to tab audio
      stream = await new Promise((resolve, reject) => {
        chrome.tabCapture.capture({ audio: true, video: false }, s => {
          if (chrome.runtime.lastError || !s) reject(chrome.runtime.lastError);
          else resolve(s);
        });
      });
      console.log("✅ Tab audio capture started.");
    }

    // Initialize recorder
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorder.ondataavailable = event => {
      if (event.data.size > 0) audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      updateStatus("processing", "Processing Audio...", "Uploading and transcribing...");
      const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
      stopStream(stream);
      await sendToBackend(audioBlob);
    };

    mediaRecorder.start();
    isRecording = true;
    updateStatus("recording", "Recording...", "Speak or let the meeting run.");
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } catch (error) {
    console.error("❌ Failed to start recording:", error);
    updateStatus("idle", "Microphone Error", "Please allow mic or restart Chrome.");
    alert("Please allow microphone access in Chrome Settings → Privacy → Site Permissions → Microphone.");
  }
});

// Stop recording logic
stopBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    isRecording = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    updateStatus("processing", "Processing...", "Finalizing audio...");
  } else {
    console.log("No active recorder to stop.");
    updateStatus("idle", "Idle", "Click Start to record a new meeting.");
  }
});

// Send to backend (Flask)
async function sendToBackend(audioBlob) {
  const formData = new FormData();
  formData.append("file", audioBlob, "meeting.webm");

  try {
    const response = await fetch(BACKEND_URL, {
      method: "POST",
      body: formData
    });

    if (!response.ok) throw new Error(`Server error: ${response.status}`);
    const result = await response.json();

    console.log("✅ Summary received:", result);
    updateStatus("processing", "Summary Received!", "See below.");
    summarySection.style.display = "block";
    summaryContent.textContent = result.summary || "No summary available.";
  } catch (err) {
    console.error("❌ Failed to send to backend:", err);
    updateStatus("idle", "Error", "Failed to upload audio to server.");
  }
}
