"""Strict JSON schemas used by the Responses API."""

from __future__ import annotations

from copy import deepcopy


REVIEW_STATUSES = ["人物理解", "待确认", "正式设定"]
CHANGE_STATUSES = ["异常行为", "潜在变化", "确认变化", "无变化", "待确认"]
RELATIONSHIP_CHANGE_STATUSES = ["新增", "升级", "弱化", "破裂", "稳定", "待确认"]


def _object(properties, required=None):
    return {
        "type": "object",
        "properties": properties,
        "required": required or list(properties.keys()),
        "additionalProperties": False,
    }


def _array(items):
    return {"type": "array", "items": items}


def _string_enum(values):
    return {"type": "string", "enum": values}


EVIDENCE = _object(
    {
        "evidence_id": {"type": "string"},
        "scene_id": {"type": "string"},
        "source_locator": {"type": "string"},
        "kind": _string_enum(["台词", "行为", "他人评价", "场面事实"]),
        "speaker": {"type": "string"},
        "quote_or_action": {"type": "string"},
        "interpretation": {"type": "string"},
        "directness": _string_enum(["明确", "推断"]),
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    }
)


ASSERTION = _object(
    {
        "claim": {"type": "string"},
        "review_status": _string_enum(REVIEW_STATUSES),
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "evidence_ids": _array({"type": "string"}),
        "counterevidence_ids": _array({"type": "string"}),
        "notes": {"type": "string"},
    }
)


SCENE_CHARACTER = _object(
    {
        "name": {"type": "string"},
        "aliases": _array({"type": "string"}),
        "is_present": {"type": "boolean"},
        "explicit_words": _array(EVIDENCE),
        "actions": _array(EVIDENCE),
        "other_people_views": _array(EVIDENCE),
        "surface_impression": {"type": "string"},
        "deeper_need": {"type": "string"},
        "current_want": {"type": "string"},
        "current_fear": {"type": "string"},
        "current_emotion": {"type": "string"},
        "conflict_response": {"type": "string"},
        "intimacy_pattern": {"type": "string"},
        "speech_style": {"type": "string"},
        "possible_contradictions": _array({"type": "string"}),
        "will_not_say_or_do": _array({"type": "string"}),
        "knowledge_changes": _array(
            _object(
                {
                    "fact_id": {"type": "string"},
                    "fact": {"type": "string"},
                    "change": _string_enum(["得知", "误以为", "怀疑", "忘记或否认", "无变化"]),
                    "evidence_ids": _array({"type": "string"}),
                }
            )
        ),
        "possible_changes": _array(
            _object(
                {
                    "dimension": {"type": "string"},
                    "before": {"type": "string"},
                    "after": {"type": "string"},
                    "trigger": {"type": "string"},
                    "status": _string_enum(CHANGE_STATUSES),
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "evidence_ids": _array({"type": "string"}),
                }
            )
        ),
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "review_status": _string_enum(REVIEW_STATUSES),
    }
)


SCENE_RELATIONSHIP = _object(
    {
        "person_a": {"type": "string"},
        "person_b": {"type": "string"},
        "surface_relation": {"type": "string"},
        "underlying_state": {"type": "string"},
        "a_view_of_b": {"type": "string"},
        "b_view_of_a": {"type": "string"},
        "a_wants": {"type": "string"},
        "b_wants": {"type": "string"},
        "initiative": {"type": "string"},
        "power_balance": {"type": "string"},
        "tension": {"type": "string"},
        "change": {"type": "string"},
        "stage": {"type": "string"},
        "hidden_information": _array({"type": "string"}),
        "evidence_ids": _array({"type": "string"}),
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "review_status": _string_enum(REVIEW_STATUSES),
    }
)


STORY_FACT = _object(
    {
        "fact_id": {"type": "string"},
        "fact": {"type": "string"},
        "truth_status": _string_enum(["剧本事实", "角色认知", "传闻", "待确认"]),
        "audience_status": _string_enum(["已向用户公开", "尚未向用户公开", "仅特定路线公开", "无法判断"]),
        "known_by": _array({"type": "string"}),
        "not_known_by": _array({"type": "string"}),
        "evidence_ids": _array({"type": "string"}),
    }
)


SCENE_ANALYSIS_SCHEMA = _object(
    {
        "scene_id": {"type": "string"},
        "heading": {"type": "string"},
        "synopsis": {"type": "string"},
        "chronology_marker": {"type": "string"},
        "characters": _array(SCENE_CHARACTER),
        "relationships": _array(SCENE_RELATIONSHIP),
        "story_facts": _array(STORY_FACT),
        "unresolved_questions": _array({"type": "string"}),
    }
)


QUICK_PREVIEW_CHARACTER = _object(
    {
        "name": {"type": "string"},
        "aliases": _array({"type": "string"}),
        "one_line_portrait": {"type": "string"},
        "evidence_scene_ids": _array({"type": "string"}),
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    }
)


QUICK_PREVIEW_RELATIONSHIP = _object(
    {
        "person_a": {"type": "string"},
        "person_b": {"type": "string"},
        "relation_label": {"type": "string"},
        "one_line_summary": {"type": "string"},
        "evidence_scene_ids": _array({"type": "string"}),
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    }
)


QUICK_SCRIPT_PREVIEW_SCHEMA = _object(
    {
        "characters": _array(QUICK_PREVIEW_CHARACTER),
        "relationships": _array(QUICK_PREVIEW_RELATIONSHIP),
        "unresolved_questions": _array({"type": "string"}),
    }
)


CHARACTER_WINDOW_SCHEMA = _object(
    {
        "character_name": {"type": "string"},
        "phase_label": {"type": "string"},
        "start_scene": {"type": "string"},
        "end_scene": {"type": "string"},
        "state_at_start": {"type": "string"},
        "state_at_end": {"type": "string"},
        "stable_patterns": _array(ASSERTION),
        "possible_changes": _array(
            _object(
                {
                    "dimension": {"type": "string"},
                    "before": {"type": "string"},
                    "after": {"type": "string"},
                    "trigger": {"type": "string"},
                    "status": _string_enum(CHANGE_STATUSES),
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "evidence_ids": _array({"type": "string"}),
                }
            )
        ),
        "contradictions": _array(ASSERTION),
        "knowledge_state": _array({"type": "string"}),
        "unresolved_questions": _array({"type": "string"}),
    }
)


ARC = _object(
    {
        "starting_state": {"type": "string"},
        "stages": _array(
            _object(
                {
                    "stage": {"type": "string"},
                    "state": {"type": "string"},
                    "key_behavior": {"type": "string"},
                    "change_status": _string_enum(CHANGE_STATUSES),
                    "evidence_ids": _array({"type": "string"}),
                }
            )
        ),
        "turning_points": _array(
            _object(
                {
                    "scene_id": {"type": "string"},
                    "trigger": {"type": "string"},
                    "before": {"type": "string"},
                    "after": {"type": "string"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "evidence_ids": _array({"type": "string"}),
                }
            )
        ),
        "ending_state": {"type": "string"},
        "overall_change": {"type": "string"},
        "change_confirmed": {"type": "boolean"},
    }
)


POSTER_BRIEF = _object(
    {
        "first_glance_message": {"type": "string"},
        "expression": _array(ASSERTION),
        "posture_and_action": _array(ASSERTION),
        "clothing_and_props": _array(ASSERTION),
        "color_and_light": _array(ASSERTION),
        "copy_tone": _array(ASSERTION),
        "avoid_mismatches": _array(ASSERTION),
        "note": {"type": "string"},
    }
)


CHARACTER_CARD_SCHEMA = _object(
    {
        "character_name": {"type": "string"},
        "aliases": _array({"type": "string"}),
        "one_line_positioning": _array(ASSERTION),
        "first_impression": _array(ASSERTION),
        "deeper_personality_and_needs": _array(ASSERTION),
        "most_wanted": _array(ASSERTION),
        "greatest_fears": _array(ASSERTION),
        "conflict_pattern": _array(ASSERTION),
        "intimacy_pattern": _array(ASSERTION),
        "central_contradictions": _array(ASSERTION),
        "speech_rhythm_wording_emotion": _array(ASSERTION),
        "will_not_say_or_do": _array(ASSERTION),
        "arc": ARC,
        "personality_changes": _array(
            _object(
                {
                    "dimension": {"type": "string"},
                    "initial_state": {"type": "string"},
                    "current_state": {"type": "string"},
                    "change_nature": _string_enum(
                        ["临时情绪", "情境行为", "潜在成长", "稳定变化", "无变化", "待观察"]
                    ),
                    "strengthened_traits": _array({"type": "string"}),
                    "weakened_traits": _array({"type": "string"}),
                    "trigger": {"type": "string"},
                    "scene_ids": _array({"type": "string"}),
                    "evidence_ids": _array({"type": "string"}),
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                }
            )
        ),
        "personality_change_summary": {"type": "string"},
        "personality_watchlist": _array({"type": "string"}),
        "poster_brief": POSTER_BRIEF,
        "unconfirmed_questions": _array({"type": "string"}),
    }
)


RELATIONSHIP_WINDOW_SCHEMA = _object(
    {
        "person_a": {"type": "string"},
        "person_b": {"type": "string"},
        "phase_label": {"type": "string"},
        "start_scene": {"type": "string"},
        "end_scene": {"type": "string"},
        "surface_relation": {"type": "string"},
        "underlying_state": {"type": "string"},
        "asymmetries": _array(ASSERTION),
        "power_and_initiative": _array(ASSERTION),
        "changes": _array(ASSERTION),
        "hidden_information": _array(ASSERTION),
        "unresolved_questions": _array({"type": "string"}),
    }
)


RELATIONSHIP_FILE_SCHEMA = _object(
    {
        "person_a": {"type": "string"},
        "person_b": {"type": "string"},
        "relationship_type": {"type": "string"},
        "relationship_strength": {"type": "number", "minimum": 0, "maximum": 1},
        "relationship_direction": _string_enum(["双向", "A→B", "B→A", "不明确"]),
        "how_they_met": _array(ASSERTION),
        "surface_relation": _array(ASSERTION),
        "underlying_state": _array(ASSERTION),
        "a_view_of_b": _array(ASSERTION),
        "b_view_of_a": _array(ASSERTION),
        "a_wants": _array(ASSERTION),
        "b_wants": _array(ASSERTION),
        "initiative_and_control": _array(ASSERTION),
        "important_shared_events": _array(ASSERTION),
        "current_conflict": _array(ASSERTION),
        "unspoken_information": _array(ASSERTION),
        "timeline": _array(
            _object(
                {
                    "stage": {"type": "string"},
                    "state": {"type": "string"},
                    "change_event": {"type": "string"},
                    "scene_ids": _array({"type": "string"}),
                    "evidence_ids": _array({"type": "string"}),
                }
            )
        ),
        "breakthroughs": _array(
            _object(
                {
                    "breakthrough_type": _string_enum(
                        [
                            "初次建立联系",
                            "信任增加",
                            "关系确认",
                            "秘密共享",
                            "立场改变",
                            "冲突升级",
                            "背叛或破裂",
                            "转为双向",
                            "主动权转移",
                            "其他",
                        ]
                    ),
                    "scene_id": {"type": "string"},
                    "stage": {"type": "string"},
                    "before": {"type": "string"},
                    "after": {"type": "string"},
                    "significance": {"type": "string"},
                    "evidence_ids": _array({"type": "string"}),
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                }
            )
        ),
        "graph_stages": _array(
            _object(
                {
                    "stage": {"type": "string"},
                    "start_scene": {"type": "string"},
                    "end_scene": {"type": "string"},
                    "relation_label": {"type": "string"},
                    "strength": {"type": "number", "minimum": 0, "maximum": 1},
                    "change_status": _string_enum(RELATIONSHIP_CHANGE_STATUSES),
                    "direction": _string_enum(["双向", "A→B", "B→A", "不明确"]),
                    "latest_change": {"type": "string"},
                    "scene_ids": _array({"type": "string"}),
                    "evidence_ids": _array({"type": "string"}),
                }
            )
        ),
        "current_stage": {"type": "string"},
        "story_truth_vs_audience_view": _array(ASSERTION),
        "unresolved_questions": _array({"type": "string"}),
    }
)


STORY_PROGRESS_SCHEMA = _object(
    {
        "overall_progress": {"type": "string"},
        "overall_pace": _string_enum(["偏慢", "平稳", "偏快", "波动明显", "待确认"]),
        "pace_score": {"type": "number", "minimum": 0, "maximum": 100},
        "stages": _array(
            _object(
                {
                    "stage": {"type": "string"},
                    "start_scene": {"type": "string"},
                    "end_scene": {"type": "string"},
                    "progress_summary": {"type": "string"},
                    "narrative_tasks_completed": _array({"type": "string"}),
                    "conflict_phase": _string_enum(
                        ["铺垫", "冲突开始", "冲突升级", "高潮", "缓和", "转场", "待确认"]
                    ),
                    "pace": _string_enum(["过慢", "稍慢", "合适", "稍快", "过快", "待确认"]),
                    "pace_reason": {"type": "string"},
                    "repetition_or_stall": _array({"type": "string"}),
                    "inactive_character_or_relationship_lines": _array({"type": "string"}),
                    "scene_ids": _array({"type": "string"}),
                }
            )
        ),
        "stage_comparisons": _array(
            _object(
                {
                    "from_stage": {"type": "string"},
                    "to_stage": {"type": "string"},
                    "plot_changes": _array({"type": "string"}),
                    "character_state_changes": _array({"type": "string"}),
                    "relationship_changes": _array({"type": "string"}),
                    "foreshadowing_changes": _array({"type": "string"}),
                    "conflict_changes": _array({"type": "string"}),
                    "information_gap_changes": _array({"type": "string"}),
                    "evidence_scene_ids": _array({"type": "string"}),
                }
            )
        ),
        "version_comparison": _object(
            {
                "has_previous_version": {"type": "boolean"},
                "previous_source_name": {"type": "string"},
                "added_or_expanded": _array({"type": "string"}),
                "removed_or_weakened": _array({"type": "string"}),
                "materially_changed": _array({"type": "string"}),
                "character_changes": _array({"type": "string"}),
                "relationship_changes": _array({"type": "string"}),
                "pace_changes": _array({"type": "string"}),
                "notes": {"type": "string"},
            }
        ),
        "priority_notes": _array({"type": "string"}),
    }
)


TIKTOK_CONTENT_SCHEMA = _object(
    {
        "generated_at": {"type": "string"},
        "market": {"type": "string"},
        "trend_summary": {"type": "string"},
        "trends": _array(
            _object(
                {
                    "trend_name": {"type": "string"},
                    "trend_type": {"type": "string"},
                    "heat_stage": _string_enum(["上升", "高位", "稳定", "降温", "无法确认"]),
                    "why_it_fits": {"type": "string"},
                    "source_title": {"type": "string"},
                    "source_url": {"type": "string"},
                    "source_date": {"type": "string"},
                }
            )
        ),
        "concepts": _array(
            _object(
                {
                    "intensity": _string_enum(["安全传播版", "大胆暧昧版", "争议讨论版"]),
                    "title": {"type": "string"},
                    "one_line_story": {"type": "string"},
                    "trend_connection": {"type": "string"},
                    "hook_first_3_seconds": {"type": "string"},
                    "duration_seconds": {"type": "integer", "enum": [15, 30, 60]},
                    "script": _array(
                        _object(
                            {
                                "timecode": {"type": "string"},
                                "visual": {"type": "string"},
                                "dialogue_or_voiceover": {"type": "string"},
                                "on_screen_text": {"type": "string"},
                            }
                        )
                    ),
                    "shot_notes": _array({"type": "string"}),
                    "sound_suggestion": {"type": "string"},
                    "cover_title": {"type": "string"},
                    "caption": {"type": "string"},
                    "hashtags": _array({"type": "string"}),
                    "comment_prompt": {"type": "string"},
                    "publish_timing": {"type": "string"},
                    "source_scene_ids": _array({"type": "string"}),
                    "trend_match_score": {"type": "number", "minimum": 0, "maximum": 100},
                    "viral_potential_score": {"type": "number", "minimum": 0, "maximum": 100},
                    "risk_level": _string_enum(["低", "中", "高"]),
                    "risk_notes": _array({"type": "string"}),
                }
            )
        ),
        "release_plan": _array(
            _object(
                {
                    "timing": _string_enum(["更新前", "更新当天", "更新后", "更新间隔"]),
                    "content_goal": {"type": "string"},
                    "recommended_concept": {"type": "string"},
                }
            )
        ),
        "safety_note": {"type": "string"},
    }
)


def schema_copy(schema):
    return deepcopy(schema)
