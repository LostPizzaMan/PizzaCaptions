DEFAULT_BLOCKED_PHRASES = [
    "thank you for watching",
    "thanks for watching",
    "thank you so much for watching",
    "see you in the next video",
    "like and subscribe",
    "subtitles by the amara.org community",
    "ご視聴ありがとうございました",
    "ご視聴ありがとうございます",
    "ご視聴いただきありがとうございます",
    "最後までご覧いただきありがとうございます",
    "チャンネル登録お願いします",
    "チャンネル登録よろしくお願いします",
    "谢谢观看",
    "感谢观看",
    "谢谢大家观看",
    "字幕由amara.org社区提供",
    "시청해주셔서 감사합니다",
    "구독과 좋아요",
    "спасибо за просмотр",
    "подписывайтесь на канал",
    "merci d'avoir regardé",
    "vielen dank fürs zuschauen",
    "gracias por ver el video",
]


def normalize(text: str) -> str:
    return "".join(ch for ch in text if ch.isalnum()).casefold()


def is_blocked(text: str, extra_phrases=()) -> bool:
    norm = normalize(text)
    if not norm:
        return False
    for phrase in DEFAULT_BLOCKED_PHRASES:
        p = normalize(phrase)
        if p and p in norm:
            return True
    for phrase in extra_phrases:
        p = normalize(phrase)
        if p and p in norm:
            return True
    return False
