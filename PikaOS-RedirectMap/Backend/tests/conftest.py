"""Put the Backend/ dir on sys.path so tests import the app package as `app.*`
(pytest is run from Backend/, same as the app's own imports)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
