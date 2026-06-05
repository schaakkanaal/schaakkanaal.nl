from flask import Flask, request
from flask_cors import CORS

from dimitri_engine import get_move

app = Flask(__name__)

CORS(app)

@app.route("/move")
def move():

    fen = request.args.get("fen")

    if not fen:
        return "Geen FEN ontvangen"

    zet = get_move(fen)

    return zet


if __name__ == "__main__":
    app.run(debug=True)