"""Real NIKKE scheduling fixtures, conservative matching and plugin isolation."""
import copy
import hashlib
import json
import shutil
import unittest
import urllib.error
from unittest.mock import patch
from zoneinfo import ZoneInfo

from app import Application
from acg_calendar.gamekee import GameKeeProvider, NoticeParser, article_id, compile_feed, content_blocks
from acg_calendar.gamekee_http import GameKeeHTTP
from acg_calendar.parser import ROOT, stamp
from acg_calendar.plugin_media import import_image, local_file
from acg_calendar.providers import create_registry
from acg_calendar.reminders import ReminderEngine
from acg_calendar.network import NetworkManager, NetworkDeferred, deferring_images
from test_calendar import TempStoreTest
from test_network import Clock, Reply

PACKAGE = ROOT / "plugins/nikke-global"
NOW = stamp("2026-10-19T18:00:00Z")


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


class NoticeTests(unittest.TestCase):
    def setUp(self):
        self.rules = read(PACKAGE / "rules.json")
        self.source = read(PACKAGE / "manifest.json")["source"]
        self.notice = read(PACKAGE / "sources/723266.json")
        self.cards = read(ROOT / "tests/fixtures/gamekee-nikke-cards.json")["data"]
        self.feed = compile_feed(self.cards, [self.notice], self.rules, self.source, "2026-10-19T18:00:00Z", NOW)
        self.version = self.feed["versions"][0]
        self.events = self.version["events"]

    def test_real_notice_overrides_five_cards_and_records_nine_conflicts(self):
        self.assertEqual(len(self.events), 24)
        self.assertEqual(self.version["analysis"]["matched_cards"], 5)
        self.assertEqual(len(self.version["analysis"]["conflicts"]), 9)
        self.assertFalse(self.version["analysis"]["ai_used"])
        event = next(e for e in self.events if e["id"] == "calendar-7889")
        self.assertEqual(event["start"]["at"], "2026-10-08T06:00:00Z")
        self.assertEqual(event["start"]["state"], "estimated")
        self.assertEqual(event["end"]["at"], "2026-12-02T19:59:59Z")
        self.assertEqual(event["end"]["state"], "exact")
        self.assertEqual(event["image_match"], "exact_calendar_activity")

    def test_maintenance_uses_beijing_and_activity_uses_explicit_utc9(self):
        self.assertEqual(self.version["maintenance"]["start"], "2026-10-08T02:00:00Z")
        self.assertEqual(self.version["maintenance"]["planned_end"], "2026-10-08T06:00:00Z")
        event = next(e for e in self.events if e["id"] == "calendar-7890")
        self.assertEqual(event["end"]["at"], "2026-10-28T14:59:59Z")
        self.assertEqual(stamp(event["end"]["at"]).astimezone(ZoneInfo('America/New_York')).hour, 10)

    def test_challenge_merges_but_shop_repeated_windows_and_unknown_update_stay_separate(self):
        root = next(e for e in self.events if e["id"] == "calendar-7888")
        children = [e for e in self.events if e.get("parent_id") == root["id"]]
        self.assertEqual({e["category"] for e in children}, {"exchange"})
        self.assertEqual(len(root["evidence"]["merged_events"]), 1)
        self.assertIn("挑战关卡时间", root["description"])
        self.assertFalse(any("挑战关卡" in e["title"] or "妮姬试用功能" in e["title"] or "周年情报站" in e["title"] for e in self.events))
        self.assertEqual(sum("FULL BURST DAY" in e["title"] for e in self.events), 2)
        ginger = next(e for e in self.events if "GINGERBREAD HOUSE" in e["title"])
        self.assertIsNone(ginger["start"]["at"])
        self.assertEqual(ginger["time_kind"], "point")

    def test_card_only_and_wrong_server_never_become_exact(self):
        cards = copy.deepcopy(self.cards)
        cards.append({**cards[0], "id": 99999, "pub_area": "国服"})
        result = compile_feed(cards, [], self.rules, self.source, "now", NOW)["versions"][0]
        self.assertFalse(any(e["id"] == "calendar-99999" for e in result["events"]))
        self.assertTrue(all(e["end"]["state"] == "estimated" for e in result["events"]))

    def test_ambiguous_title_does_not_guess_or_reuse_notice_image(self):
        notice = copy.deepcopy(self.notice)
        # Two matching event sections must not arbitrarily select either.
        rules = copy.deepcopy(self.rules)
        # Broad names intentionally create ambiguity within a single notice.
        rules["matching"]["name_pattern"] = "LITTLE WITCH TRICK|DAILY TRICK"
        card = next(copy.deepcopy(c) for c in self.cards if c["id"] == 7888)
        card["title"] = "LITTLE WITCH TRICK DAILY TRICK"
        result = compile_feed([card], [notice], rules, self.source, "now", NOW)
        event = next(e for e in result["versions"][0]["events"] if e["id"] == "calendar-7888")
        self.assertEqual(event["evidence"]["basis"], "calendar_only")
        self.assertEqual(event["image_url"], card["picture"])

    def test_editor_reader_and_url_scopes(self):
        self.assertEqual(content_blocks('[{"children":[{"text":"活动时间"}]}]')[0]["text"], "活动时间")
        self.assertEqual(article_id("https://www.gamekee.com/nikke/723266.html", "nikke"), 723266)
        self.assertIsNone(article_id("https://evil.example/nikke/723266.html", "nikke"))
        http = GameKeeHTTP("nikke", 1253)
        self.assertTrue(http.allowed("https://www.gamekee.com/v1/activity/page-list?serverId=19"))
        self.assertTrue(http.allowed("//cdnimg-v2.gamekee.com/wiki2.0/pro/1253/images/test.png", image=True))
        self.assertTrue(http.allowed("//cdnimg-v2.gamekee.com/wiki2.0/pro/215/images/test.jpg", image=True))
        for url in ["http://127.0.0.1/test.png", "https://cdnimg-v2.gamekee.com.evil.example/a.png", "https://cdnimg-v2.gamekee.com/wiki2.0/pro/1253/images/%2e%2e/a.png", "https://cdnimg-v2.gamekee.com/wiki2.0/pro/1253/images/a.svg", "https://cdnimg-v2.gamekee.com/wiki2.0/pro/999/images/a.png"]:
            self.assertFalse(http.allowed(url, image=True), url)

    def test_october_29_calendar_provides_distinct_allowed_pictures(self):
        cards = read(ROOT / 'tests/fixtures/gamekee-nikke-20261029-cards.json')['data']
        feed = compile_feed(cards, [], self.rules, self.source, 'checked', stamp('2026-11-04T12:00:00Z'))
        events = feed['versions'][0]['events']; http = GameKeeHTTP('nikke', 1253)
        self.assertEqual(len(events), 11)
        self.assertTrue(all(e.get('image_url') and http.allowed(e['image_url'], image=True) for e in events))
        self.assertEqual(len({e['image_url'] for e in events}), 11)
        self.assertTrue(all(e['end']['state'] == 'estimated' for e in events))


class PluginTests(TempStoreTest):
    def setUp(self):
        super().setUp()
        self.plugin = self.directory / "plugins/nikke-global"
        shutil.copytree(PACKAGE, self.plugin)
        self.manifest = read(self.plugin / "manifest.json")
        self.provider = GameKeeProvider(self.plugin, self.manifest, self.store)

    def test_discovery_offline_snapshot_logo_headings_and_currency_isolation(self):
        app = Application(self.directory, auto_sync=False, desktop=False)
        self.assertEqual(app.registry.errors, [])
        game = next(g for g in app.state()["games"] if g["id"] == "nikke-global")
        self.assertNotIn("currency", game)
        self.assertRegex(game["icon"], r"^/api/artwork/[a-f0-9]{32}\.png$")
        events = [e for e in app.state()["events"] if e["game"] == "nikke-global"]
        self.assertEqual(len(events), 24)
        self.assertEqual(sum(bool(e.get("artwork")) for e in events), 14)
        self.assertTrue(all(e["source"]["kind"] == "gamekee" for e in events))
        self.assertEqual(app.registry.rules("nikke-global")["time"]["conflict_policy"], "prefer_notice")

    def test_personal_state_survives_period_move_and_bad_snapshot(self):
        self.provider.seed()
        before = self.store.versions()
        event = before[0]["events"][0]
        self.store.update_state(event["id"], {"starred": True, "notes": "保留"})
        feed = read(self.plugin / "events.json")
        feed["versions"][0]["id"] = "future-period"
        after = self.provider.normalize(feed)
        self.assertEqual(event["id"], after[0]["events"][0]["id"])
        self.store.replace_game_versions("nikke-global", after)
        self.assertTrue(self.store.state()[event["id"]]["starred"])
        feed["versions"][0]["events"][0]["evidence"] = []
        with self.assertRaises(ValueError):
            self.provider.normalize(feed)

    def test_local_media_traversal_and_nonimage_are_rejected(self):
        for value in ["../outside.png", "C:/Windows/a.png", "assets\\a.png"]:
            with self.assertRaises(ValueError):
                local_file(self.plugin, value)
        (self.plugin / "assets/bad.png").write_text("<svg onload='bad'/>")
        with self.assertRaises(ValueError):
            import_image(self.plugin, "assets/bad.png", self.directory)

    def test_server_mismatch_or_incomplete_page_preserves_snapshot(self):
        self.provider.seed()
        before = self.store.versions()
        for responses in [
            [{"code": 0, "data": [{"id": 34, "game_id": 1253, "name": "国服"}]}],
            [{"code": 0, "data": [{"id": 19, "game_id": 1253, "name": "外服"}]}, {"code": 0, "data": [{"id": 1}], "meta": {"pagination": {"page_total": 2}}}]
        ]:
            with patch.object(self.provider, "read_json", side_effect=responses), self.assertRaises(ValueError):
                self.provider.collect(now=NOW)
            self.assertEqual(self.store.versions(), before)

    def test_cached_notice_reused_when_timestamp_unchanged(self):
        metadata = {"game_id": 1253, "updated_at": read(self.plugin / "sources/723266.json")["updated_at"]}
        with patch.object(self.provider, "read_json", return_value={"data": metadata}), patch.object(self.provider.http, "read", side_effect=AssertionError("CDN should not be requested")):
            self.assertEqual(self.provider.notice(723266)["id"], 723266)

    def test_blocked_notice_cdn_cannot_prevent_calendar_pictures_or_disable_limiter(self):
        cards = [r for r in read(ROOT / 'tests/fixtures/gamekee-nikke-20261029-cards.json')['data'] if r['id'] in (7991, 7994)]
        picture = (self.plugin / 'assets/app-icon.png').read_bytes()
        calls, clock = [], Clock()

        class Opener:
            def open(inner, request, timeout):
                url = request.full_url; calls.append(url)
                if 'cdnimg-v2.gamekee.com' in url:
                    return Reply(picture, {'Content-Type': 'image/png'})
                if 'api-cdn.gamekee.com' in url:
                    raise urllib.error.HTTPError(url, 567, 'CDN unavailable', {}, None)
                if '/gameServer/list' in url:
                    data = [{'id': 19, 'game_id': 1253, 'name': '外服'}]
                elif '/activity/page-list' in url:
                    data = cards
                else:
                    cid = int(url.rsplit('/', 1)[1])
                    data = {'game_id': 1253, 'title': '更新公告', 'updated_at': 1, 'content_cdn': f'https://api-cdn.gamekee.com/wiki2.0/pro/1253/content/{cid}.json'}
                return Reply(json.dumps({'code': 0, 'data': data}).encode())

        manager = NetworkManager(self.store, clock=clock, waiter=clock.advance, opener=Opener(), uniform=lambda a, b: 0)
        self.store.network = manager
        feed = self.provider.collect(stamp('2026-11-04T12:00:00Z'))
        self.assertTrue(all(e.get('artwork') for e in feed['versions'][0]['events']))
        cdn_calls = [u for u in calls if 'api-cdn.gamekee.com' in u]
        image_calls = [u for u in calls if 'cdnimg-v2.gamekee.com' in u]
        self.assertEqual(len(image_calls), 2)
        self.assertEqual(len(cdn_calls), 1, 'One rejected CDN probe must suppress other probes for 24 hours')
        self.assertTrue(all(calls.index(u) < calls.index(cdn_calls[0]) for u in image_calls))
        self.assertIn('HTTP 567', ' '.join(feed['versions'][0]['warnings']))
        status = self.store.get_meta(self.provider.sync_key)
        self.assertEqual(status['result']['images']['added'], 2)
        self.assertFalse(status['running'])
        with manager.job(), self.assertRaises(NetworkDeferred):
            self.provider.http.read('https://www.gamekee.com/v1/content/detail/999999')
        clock.advance(60)
        self.provider.collect(stamp('2026-11-04T12:01:00Z'))
        self.assertEqual(len([u for u in calls if 'api-cdn.gamekee.com' in u]), 1)
        self.assertEqual(manager.policy['interval_seconds'], 10)

    def test_successful_deferred_body_is_read_once_and_updates_times_after_images(self):
        card = copy.deepcopy(read(ROOT / 'tests/fixtures/gamekee-nikke-20261029-cards.json')['data'][0])
        card.update(title='【活动】SAMPLE EVENT', link_url='https://www.gamekee.com/nikke/725772.html')
        metadata = {'game_id': 1253, 'title': '10月29日版本更新公告', 'updated_at': 1, 'content_cdn': 'https://api-cdn.gamekee.com/wiki2.0/pro/1253/content/725772.json'}
        body = json.dumps({'content': [{'children': [{'text': '4 SAMPLE EVENT'}]}, {'children': [{'text': '*活动时间：2026年10月29日12:00:00～2026年11月19日04:59:59（UTC+9）'}]}]}).encode()
        calls = []
        def response(url, image=False):
            from acg_calendar.network import ImageDeferred, _defer_images
            if image and _defer_images.get(): raise ImageDeferred('deferred')
            calls.append('image' if image else 'body')
            return (self.plugin / 'assets/app-icon.png').read_bytes() if image else body
        replies = [{'code': 0, 'data': [{'id': 19, 'game_id': 1253, 'name': '外服'}]}, {'code': 0, 'data': [card]}, {'code': 0, 'data': metadata}]
        with patch.object(self.provider, 'read_json', side_effect=replies) as read_json, patch.object(self.provider.http, 'read', side_effect=response):
            feed = self.provider.collect(stamp('2026-11-04T12:00:00Z'))
        self.assertEqual(read_json.call_count, 3, 'Deferred body must reuse its already-read metadata')
        self.assertEqual(calls, ['image', 'body'])
        event = feed['versions'][0]['events'][0]
        self.assertEqual(event['id'], 'calendar-' + str(card['id']))
        self.assertEqual(event['end']['state'], 'exact')
        self.assertEqual(event['end']['at'], '2026-11-18T19:59:59Z')
        self.assertTrue(event.get('artwork'))
        self.assertEqual(feed['versions'][0]['warnings'], [])

    def test_cached_pictures_do_not_consume_new_download_budget(self):
        events = copy.deepcopy(read(ROOT / 'tests/fixtures/gamekee-nikke-20261029-cards.json')['data'][:2])
        feed = compile_feed(events, [], self.provider.config, self.provider.source, 'checked', stamp('2026-11-04T12:00:00Z'))
        self.provider.config['collection']['max_images'] = 1
        url = 'https:' + events[0]['picture']; key = hashlib.sha256(url.encode()).hexdigest()[:32]
        picture = (self.plugin / 'assets/app-icon.png').read_bytes()
        (self.plugin / 'assets' / (key + '.png')).write_bytes(picture)
        with patch.object(self.provider.http, 'read', return_value=picture) as fetch:
            self.provider.attach_images(feed)
        self.assertEqual(fetch.call_count, 1)
        self.assertTrue(all(e.get('artwork') for e in feed['versions'][0]['events']))

    def test_duplicate_failed_urls_are_not_retried_and_deferred_is_not_failure(self):
        cards = read(ROOT / 'tests/fixtures/gamekee-nikke-20261029-cards.json')['data'][:2]
        cards = copy.deepcopy(cards); cards[1]['picture'] = cards[0]['picture']
        feed = compile_feed(cards, [], self.provider.config, self.provider.source, 'checked', stamp('2026-11-04T12:00:00Z'))
        with deferring_images():
            self.provider.attach_images(feed)
        self.assertEqual(feed['versions'][0]['analysis']['artwork']['download_errors'], 0)
        with patch.object(self.provider.http, 'read', side_effect=OSError('unavailable')) as fetch:
            attempts, failures = set(), []
            self.provider.attach_images(feed, attempts, failures)
            self.provider.attach_images(feed, attempts, failures)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(feed['versions'][0]['analysis']['artwork']['download_errors'], 1)
        self.assertEqual(feed['versions'][0]['analysis']['artwork']['pending'], 2)

    def test_inaccessible_notice_falls_back_and_image_failure_keeps_times(self):
        cards = read(ROOT / "tests/fixtures/gamekee-nikke-cards.json")
        responses = [{"code": 0, "data": [{"id": 19, "game_id": 1253, "name": "外服"}]}, cards]
        with patch.object(self.provider, "read_json", side_effect=responses), patch.object(self.provider, "notice", side_effect=OSError("unavailable")), patch.object(self.provider.http, "read", side_effect=OSError("image unavailable")):
            result = self.provider.collect(now=NOW)
        self.assertEqual(len(result["versions"][0]["events"]), 24)
        self.assertIn("上次核对", " ".join(result["versions"][0]["warnings"]))
        self.assertEqual(next(e for e in result["versions"][0]["events"] if e["id"] == "calendar-7889")["end"]["at"], "2026-12-02T19:59:59Z")

    def test_bad_rules_are_isolated_from_other_games(self):
        config = read(self.plugin / "rules.json")
        config["time"]["default_notice_offset_hours"] = 99
        (self.plugin / "rules.json").write_text(json.dumps(config), encoding="utf-8")
        registry = create_registry(self.store, self.directory)
        self.assertEqual(registry.ids, {"endfield-cn", "arknights-cn"})
        self.assertEqual(len(registry.errors), 1)

    def test_exact_end_reminds_even_when_start_is_estimated_but_cards_do_not(self):
        self.provider.seed()
        engine = ReminderEngine(self.store, sender=lambda *_: False)
        notices = engine.tick(stamp("2026-12-02T19:30:00Z"))
        self.assertTrue(any("Cinderella Special" in n["title"] for n in notices))
        self.assertEqual(engine.tick(stamp("2026-12-02T19:30:00Z")), [])
        # Anniversary information card has no announcement-confirmed clock.
        notices = engine.tick(stamp("2026-11-17T15:30:00Z"))
        self.assertFalse(any("四周年" in n["title"] for n in notices))
