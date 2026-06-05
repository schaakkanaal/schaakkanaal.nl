import subprocess
import random

ENGINE_PATH = r"stockfish\stockfish-windows-x86-64-avx2.exe"


def get_move(fen, depth=8):

    engine = subprocess.Popen(
        ENGINE_PATH,
        universal_newlines=True,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE
    )

    def send(command):
        engine.stdin.write(command + "\n")
        engine.stdin.flush()

    send("uci")
    send("isready")

    while True:
        line = engine.stdout.readline().strip()

        if line == "readyok":
            break

    send("setoption name MultiPV value 5")

    send("setoption name UCI_LimitStrength value true")
    send("setoption name UCI_Elo value 2000")

    send(f"position fen {fen}")
    send(f"go depth {depth}")

    zetten = {}

    while True:

        line = engine.stdout.readline().strip()

        if " multipv " in line and " pv " in line:

            delen = line.split()

            try:

                mpv_index = delen.index("multipv")
                pv_index = delen.index("pv")

                nummer = int(delen[mpv_index + 1])
                zet = delen[pv_index + 1]

                score = None

                if "score" in delen:

                    score_index = delen.index("score")

                    if delen[score_index + 1] == "cp":
                        score = int(delen[score_index + 2]) / 100.0

                    elif delen[score_index + 1] == "mate":
                        mate = int(delen[score_index + 2])

                        if mate > 0:
                            score = 999
                        else:
                            score = -999

                if score is not None:

                    zetten[nummer] = {
                        "move": zet,
                        "score": score
                    }

            except:
                pass

        if line.startswith("bestmove"):
            break

    engine.terminate()

    if not zetten:
        return None

    beste_score = zetten[1]["score"]

    kandidaten = []

    for nummer in sorted(zetten.keys()):

        zet = zetten[nummer]

        if zet["score"] >= beste_score - 1.2:
            kandidaten.append(zet["move"])

    if len(kandidaten) == 1:
        return kandidaten[0]

    gewichten = [40, 25, 15, 10, 10]
    gewichten = gewichten[:len(kandidaten)]

    gekozen_zet = random.choices(
        kandidaten,
        weights=gewichten,
        k=1
    )[0]

    return gekozen_zet