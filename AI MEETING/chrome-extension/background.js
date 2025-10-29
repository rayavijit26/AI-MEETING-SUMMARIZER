let mediaRecorder;
let audioChunks = [];
let isRecording = false;

const BACKEND_URL = 'http://127.0.0.1:8000/summarize/';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'startRecording') {
        startRecording();
    } else if (request.type === 'stopRecording') {
        console.log("Background received 'stopRecording' message."); // For debugging
        stopRecording();
    } else if (request.type === 'getRecordingState') {
        chrome.runtime.sendMessage({ type: 'statusUpdate', isRecording: isRecording, message: isRecording ? 'Currently recording...' : 'Ready to record.' });
    }
});

async function startRecording() {
    if (isRecording) {
        console.log("Already recording.");
        return;
    }

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const stream = await chrome.tabCapture.capture({ audio: true, video: false });
        
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            if (audioBlob.size > 0) {
                sendToServer(audioBlob);
            } else {
                console.error("Audio blob is empty, not sending to server.");
            }
            audioChunks = [];
            stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        isRecording = true;
        chrome.runtime.sendMessage({ type: 'statusUpdate', isRecording: true, message: 'Recording...' });
    } catch (error) {
        console.error("Failed to start recording:", error);
        chrome.runtime.sendMessage({ 
            type: 'statusUpdate', 
            isRecording: false, 
            message: 'Permission denied. Please allow audio capture.' 
        });
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        isRecording = false;
        chrome.runtime.sendMessage({ type: 'statusUpdate', isRecording: false, message: 'Processing audio...' });
    } else {
        console.log("Stop called but no active recorder found.");
    }
}

async function sendToServer(audioBlob) {
    const formData = new FormData();
    formData.append('file', audioBlob, 'meeting_audio.webm');

    try {
        console.log("Sending audio to server...");
        const response = await fetch(BACKEND_URL, {
            method: 'POST',
            body: formData,
        });

        const resultText = await response.text();
        console.log('Server Raw Response Body:', resultText);

        if (!response.ok) {
            throw new Error(`Server responded with status ${response.status}`);
        }

        const result = JSON.parse(resultText); 
        chrome.runtime.sendMessage({ type: 'summaryComplete', summary: result.summary });

    } catch (error) {
        console.error('Error sending to server:', error);
        chrome.runtime.sendMessage({ type: 'statusUpdate', isRecording: false, message: `Error: ${error.message}` });
    }
}