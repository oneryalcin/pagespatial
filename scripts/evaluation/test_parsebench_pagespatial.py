from parsebench_pagespatial import benchmark_markdown, layout_page


def sample_page():
    return {
        "pageNumber": 1,
        "geometry": {"width": 100, "height": 200},
        "projection": {"markdown": "# Page 1\n\n## Native structure reference\n\n# Report\n\n| A | B |\n| - | -: |\n| x | 2 |"},
        "nativeLines": [{"text": "Report", "box": [10, 20, 50, 40], "sourceIds": ["n1"]}],
        "sourceMatches": [{"ocrId": "o1"}],
        "spatialRows": [
            {"text": "Report", "box": [10, 20, 50, 40], "sourceIds": ["o1"]},
            {"text": "OCR only", "box": [5, 100, 60, 120], "sourceIds": ["o2"]},
        ],
        "derivedRelations": [
            {"kind": "chart-category-value", "attributes": {"category": "2025", "value": "42"}}
        ],
    }


def test_projection_removes_evidence_scaffolding_and_keeps_deterministic_content():
    markdown = benchmark_markdown(sample_page())
    assert "# Page 1" not in markdown
    assert "evidence page=" not in markdown
    assert markdown.count("Report") == 1
    assert "OCR only" in markdown
    assert "<table>" in markdown
    assert "2025" in markdown and "42" in markdown


def test_projection_keeps_nested_document_headings_inside_native_reference():
    page = sample_page()
    page["projection"]["markdown"] = """# Page 1

## Native structure reference

# Report

## First document section

First body.

## Second document section

Second body.
"""

    markdown = benchmark_markdown(page)

    assert "First document section" in markdown
    assert "First body." in markdown
    assert "Second document section" in markdown
    assert "Second body." in markdown


def test_projection_preserves_an_ordinary_row_after_a_blank_header():
    page = sample_page()
    page["projection"]["markdown"] = """# Page 1

## Native structure reference

| | Value |
|---|---|
| Widget | 10 |
"""

    markdown = benchmark_markdown(page)

    assert "<th></th>" in markdown
    assert "<th>Value</th>" in markdown
    assert "<td>Widget</td>" in markdown
    assert "<td>10</td>" in markdown


def test_projection_does_not_infer_headers_from_the_first_data_row():
    page = sample_page()
    page["projection"]["markdown"] = """# Page 1

## Native structure reference

| Quarterly report | | |
|---|---|---|
|Widget|10|London|
"""

    markdown = benchmark_markdown(page)

    assert "<th>Quarterly report</th>" in markdown
    assert "<td>Widget</td>" in markdown
    assert "<td>10</td>" in markdown
    assert "<td>London</td>" in markdown


def test_layout_uses_native_and_only_unmatched_ocr_rows():
    page = layout_page(sample_page(), "content")
    assert [item.value for item in page.items] == ["Report", "OCR only"]
    assert page.items[0].bbox.x == 10
    assert page.items[0].bbox.y == 20
    assert page.items[0].bbox.w == 40
    assert page.items[0].bbox.h == 20
