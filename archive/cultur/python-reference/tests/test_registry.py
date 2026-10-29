import importlib
import json

from cultur import registry


def test_registry_can_be_loaded_outside_the_source_tree(tmp_path, monkeypatch):
    path = tmp_path / "packaged-cases.json"
    path.write_text(json.dumps({"cases": [{"id": "portable", "names": ["Portable Case"]}]}), encoding="utf-8")
    try:
        with monkeypatch.context() as env:
            env.setenv("CULTUR_REGISTRY_PATH", str(path))
            importlib.reload(registry)
            assert registry.find_by_name("Portable Case")[0]["id"] == "portable"
    finally:
        importlib.reload(registry)


def test_checkout_registry_is_available():
    assert registry.PATH.is_file()
    assert registry.load()
