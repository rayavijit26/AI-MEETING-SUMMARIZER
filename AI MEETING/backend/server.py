# server.py
import os
import subprocess
from flask import Flask, request, jsonify
from flask_cors import CORS
from openai import OpenAI
import requests
from dotenv import load_dotenv
import logging

# load env
load_dotenv()

OPENAI_KEY = os.getenv("OPENAI_API_KEY")
N8N_WEBHOOK = os.getenv("N8N_WEBHOOK")  # optional, can be blank
FLASK_HOST = os.getenv("FLASK_HOST", "127.0.0.1")
FLASK_PORT = int(os.getenv("FLASK_PORT", 5000))

if not OPENAI_KEY:
    raise RuntimeError("Please set OPENAI_API_KEY in your environment or .env file")

# OpenAI client
client = OpenAI(api_key=OPENAI_KEY)

# Flask
app = Flask(__name__)
CORS(app)
logging.basicConfig(level=logging.INFO)

# Store the latest transcript in memory (for chat). For production use DB/persistence.
latest_transcript = ""

@app.route("/upload", methods=["POST"])
def upload_audio():
    """
    Accepts multipart/form-data with key 'file' (webm blob).
    Steps:
      1. Save webm
      2. Convert to wav with ffmpeg
      3. Transcribe with Whisper
      4. Summarize with GPT
      5. Post summary to n8n webhook (optional)
      6. Return JSON { summary, transcript }
    """
    global latest_transcript

    if "file" not in request.files:
        return jsonify({"error": "No file part 'file' in request"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    os.makedirs("audio", exist_ok=True)
    webm_path = os.path.join("audio", "meeting.webm")
    wav_path = os.path.join("audio", "meeting.wav")

    # Save incoming webm
    file.save(webm_path)
    app.logger.info("Saved uploaded audio to %s", webm_path)

    # Convert to wav using ffmpeg
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", webm_path, "-ar", "16000", "-ac", "1", wav_path],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        app.logger.info("Converted to wav: %s", wav_path)
    except subprocess.CalledProcessError as e:
        app.logger.exception("ffmpeg failed")
        cleanup_paths([webm_path, wav_path])
        return jsonify({"error": "ffmpeg conversion failed", "details": e.stderr.decode(errors="ignore")}), 500

    # Transcribe with Whisper
    try:
        with open(wav_path, "rb") as audio_file:
            transcribe_resp = client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file
            )
        # API returns an object; get text property
        transcript_text = getattr(transcribe_resp, "text", None) or transcribe_resp.get("text") if isinstance(transcribe_resp, dict) else str(transcribe_resp)
        latest_transcript = transcript_text
        app.logger.info("Transcription complete (%d chars)", len(latest_transcript))
    except Exception as e:
        app.logger.exception("Transcription failed")
        cleanup_paths([webm_path, wav_path])
        return jsonify({"error": "Transcription failed", "details": str(e)}), 500

    # Summarize with GPT
    try:
        # Provide a clear system message and a summarization instruction
        prompt = (
            "You are a helpful assistant that summarizes meeting transcripts. "
            "Produce a short summary (3-8 bullet points) and explicit action items (if any). "
            "Then provide a one-line subject line suitable for email."
        )
        user_content = f"{prompt}\n\nTranscript:\n{latest_transcript}"

        summary_resp = client.chat.completions.create(
            model="gpt-4-turbo",
            messages=[
                {"role": "system", "content": "You are a professional meeting summarizer."},
                {"role": "user", "content": user_content}
            ],
            max_tokens=400,
        )
        summary_text = summary_resp.choices[0].message.content.strip()
        app.logger.info("Summarization complete (%d chars)", len(summary_text))
    except Exception as e:
        app.logger.exception("Summarization failed")
        cleanup_paths([webm_path, wav_path])
        return jsonify({"error": "Summarization failed", "details": str(e)}), 500

    # Send to n8n webhook (optional)
    if N8N_WEBHOOK:
        try:
            requests.post(N8N_WEBHOOK, json={"summary": summary_text, "transcript": latest_transcript}, timeout=6)
            app.logger.info("Posted summary to n8n webhook")
        except Exception as e:
            app.logger.warning("Failed to send to n8n: %s", e)

    # cleanup local files
    cleanup_paths([webm_path, wav_path])

    return jsonify({"status": "success", "summary": summary_text, "transcript": latest_transcript})

@app.route("/chat", methods=["POST"])
def chat():
    """
    Accepts JSON { question: "<user question>" }
    Uses latest_transcript to answer query with GPT.
    """
    global latest_transcript
    data = request.get_json(force=True, silent=True) or {}
    question = data.get("question", "").strip()

    if not question:
        return jsonify({"error": "No question provided"}), 400
    if not latest_transcript:
        return jsonify({"answer": "No transcript available. Please record and upload a meeting first."}), 200

    # Create a focused prompt that uses the transcript as context
    prompt = (
        "You are a meeting assistant. Use the meeting transcript to answer the user's question. "
        "Be concise and refer to specific speakers or timestamps if present.\n\n"
        f"TRANSCRIPT:\n{latest_transcript}\n\nQUESTION:\n{question}\n\nAnswer:"
    )
    try:
        resp = client.chat.completions.create(
            model="gpt-4-turbo",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=300,
        )
        answer = resp.choices[0].message.content.strip()
        return jsonify({"answer": answer})
    except Exception as e:
        app.logger.exception("Chat generation failed")
        return jsonify({"error": "Chat generation failed", "details": str(e)}), 500

def cleanup_paths(paths):
    for p in paths:
        try:
            if os.path.exists(p):
                os.remove(p)
        except Exception:
            app.logger.exception("Failed to cleanup %s", p)

if __name__ == "__main__":
    app.run(host=FLASK_HOST, port=FLASK_PORT, debug=True)
