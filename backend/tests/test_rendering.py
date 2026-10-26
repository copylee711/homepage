from app.rendering import render_markdown


def test_media_tags_keep_size_and_drop_unsafe_attributes():
    html = render_markdown('<img src="https://a.example/x.png" alt="x" width="320" onerror="alert(1)">')
    assert 'width="320"' in html and "onerror" not in html
    html = render_markdown('<video src="https://a.example/v.mp4" controls width="480" autoplay></video>')
    assert 'width="480"' in html and "controls" in html and "autoplay" not in html


def test_only_known_video_players_can_be_embedded():
    bilibili = render_markdown('<iframe src="//player.bilibili.com/player.html?bvid=BV1pGnn67EbB&p=1"'
                               ' frameborder="no" allowfullscreen="true"></iframe>')
    assert 'src="https://player.bilibili.com/player.html?' in bilibili
    assert "autoplay=0" in bilibili and "isOutside=true" in bilibili and 'sandbox="' in bilibili
    youtube = render_markdown('<iframe src="https://www.youtube-nocookie.com/embed/g22Z__ShvVY" width="640">'
                              '</iframe>')
    assert 'src="https://www.youtube-nocookie.com/embed/g22Z__ShvVY"' in youtube
    for src in ("https://evil.example/phish", "javascript:alert(1)", "https://player.bilibili.com.evil.example/"):
        html = render_markdown(f'<iframe src="{src}" onload="x()"></iframe>')
        assert "src=" not in html and "onload" not in html, src
