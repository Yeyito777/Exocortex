import { describe, expect, test } from "bun:test";
import { buildRelevantLinksSection, extractRelevantLinks, extractRelevantLinksFromJson } from "./browse/index";

describe("browse relevant links", () => {
  test("extracts deterministic relevant links from markdown", () => {
    const markdown = `
# Example
[GitHub](https://github.com)
[Issue #24035](https://github.com/iree-org/iree/issues/24035)
[PR #24046 fix](https://github.com/iree-org/iree/pull/24046)
[pstarkcdpr](https://github.com/pstarkcdpr)
[Terms](https://github.com/site/terms)
`;

    expect(extractRelevantLinks(markdown, "https://github.com/iree-org/iree/issues/24035", "vector.step SPIR-V workaround")).toEqual([
      { text: "PR #24046 fix", url: "https://github.com/iree-org/iree/pull/24046" },
    ]);
  });

  test("handles markdown links whose URLs contain parentheses", () => {
    const markdown = `
[Attention](https://en.wikipedia.org/wiki/Attention_(machine_learning))
[Transformer](https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture))
`;

    expect(extractRelevantLinks(
      markdown,
      "https://en.wikipedia.org/wiki/Attention_(machine_learning)",
      "Summarize the article and preserve related concept links.",
    )).toEqual([
      { text: "Transformer", url: "https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)" },
    ]);
  });

  test("filters noisy GitHub search-page links down to concrete result URLs", () => {
    const markdown = `
[Release Tracker v3.9.0 - (2025-11-24)](https://github.com/iree-org/iree/issues/22307)
[stabehlo.select fails to compile with SPIRV due to using vector.step : vector<Nxindex>](https://github.com/iree-org/iree/issues/24035)
[bug 🐞Something isn't working](https://github.com/iree-org/iree/issues?q=vector.step%20vulkan%20spirv%20label%3A%22bug%22)
[pstarkcdpr](https://github.com/iree-org/iree/issues?q=vector.step%20vulkan%20spirv%20author%3Apstarkcdpr)
[Labels](https://github.com/iree-org/iree/labels)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://github.com/iree-org/iree/issues?q=vector.step+vulkan+spirv",
      "Find issues involving vector.step or vector.extract/vector.insert_strided_slice legalization failures on Vulkan SPIR-V.",
    )).toEqual([
      {
        text: "stabehlo.select fails to compile with SPIRV due to using vector.step : vector<Nxindex>",
        url: "https://github.com/iree-org/iree/issues/24035",
      },
    ]);
  });

  test("prefers same-repo linked fixes on github issue pages", () => {
    const markdown = `
[#24046](https://github.com/iree-org/iree/pull/24046)
[MCP Registry](https://github.com/mcp)
[Changelog](https://github.blog/changelog)
[pstarkcdpr](https://github.com/pstarkcdpr)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://github.com/iree-org/iree/issues/24035",
      "Summarize the issue and linked fix.",
    )).toEqual([
      { text: "24046", url: "https://github.com/iree-org/iree/pull/24046" },
    ]);
  });

  test("dedupes repeated github entity links on issue pages", () => {
    const markdown = `
[#24046](https://github.com/iree-org/iree/pull/24046)
[#24046](https://github.com/iree-org/iree/pull/24046)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://github.com/iree-org/iree/issues/24035",
      "Summarize the issue and linked fix.",
    )).toEqual([
      { text: "24046", url: "https://github.com/iree-org/iree/pull/24046" },
    ]);
  });

  test("keeps concrete PR follow-up links while dropping repo chrome", () => {
    const markdown = `
[#24035](https://github.com/iree-org/iree/issues/24035)
[View reviewed changes](https://github.com/iree-org/iree/pull/24046/files/7fe965e35e09c3fd2399cde8683847b095647c71#diff-6d56793c3d82ff66cbf63f0475f3cd37fdf0d6fe26c6e0a759108aa4dfba10c7)
[Files changed](https://github.com/iree-org/iree/pull/24046/files)
[Commits 3](https://github.com/iree-org/iree/pull/24046/commits)
[66d5760](https://github.com/iree-org/iree/commit/66d57604953d3d679358951af778d73472a101cf)
[Actions](https://github.com/iree-org/iree/actions)
[Labels](https://github.com/iree-org/iree/labels)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://github.com/iree-org/iree/pull/24046",
      "Summarize PR #24046 and any linked fix, tests, or files changed.",
    )).toEqual([
      { text: "Files changed", url: "https://github.com/iree-org/iree/pull/24046/files" },
      { text: "66d5760", url: "https://github.com/iree-org/iree/commit/66d57604953d3d679358951af778d73472a101cf" },
      { text: "24035", url: "https://github.com/iree-org/iree/issues/24035" },
      { text: "View reviewed changes", url: "https://github.com/iree-org/iree/pull/24046/files/7fe965e35e09c3fd2399cde8683847b095647c71#diff-6d56793c3d82ff66cbf63f0475f3cd37fdf0d6fe26c6e0a759108aa4dfba10c7" },
      { text: "Commits", url: "https://github.com/iree-org/iree/pull/24046/commits" },
    ]);
  });

  test("prefers substantive rust blog links over chrome", () => {
    const markdown = `
[Rust teams](https://www.rust-lang.org/governance/)
[the "Inside Rust" blog](https://blog.rust-lang.org/inside-rust/)
[release announcements](https://blog.rust-lang.org/releases/)
[Announcing Rust 1.95.0](https://blog.rust-lang.org/2026/04/16/Rust-1.95.0/)
[Send a fix here](https://github.com/rust-lang/blog.rust-lang.org)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://blog.rust-lang.org/",
      "Summarize the most prominent posts or sections visible on the page.",
    )).toEqual([
      { text: "Announcing Rust 1.95.0", url: "https://blog.rust-lang.org/2026/04/16/Rust-1.95.0/" },
      { text: 'the "Inside Rust" blog', url: "https://blog.rust-lang.org/inside-rust/" },
      { text: "release announcements", url: "https://blog.rust-lang.org/releases/" },
    ]);
  });

  test("prefers asyncio learning links over docs chrome", () => {
    const markdown = `
[Report a bug](https://docs.python.org/3/bugs.html)
[Runners](https://docs.python.org/3/library/asyncio-runner.html)
[Coroutines and Tasks](https://docs.python.org/3/library/asyncio-task.html)
[Streams](https://docs.python.org/3/library/asyncio-stream.html)
[Show source](https://github.com/python/cpython/blob/main/Doc/library/asyncio.rst?plain=1)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://docs.python.org/3/library/asyncio.html",
      "Summarize what this page covers and which subtopics seem most important for someone learning asyncio.",
    )).toEqual([
      { text: "Coroutines and tasks", url: "https://docs.python.org/3/library/asyncio-task.html" },
      { text: "Streams", url: "https://docs.python.org/3/library/asyncio-stream.html" },
      { text: "Runners", url: "https://docs.python.org/3/library/asyncio-runner.html" },
    ]);
  });

  test("picks a clean getting-started set from hugging face docs pages", () => {
    const markdown = `
[Installation](https://huggingface.co/docs/transformers/installation)
[Quickstart](https://huggingface.co/docs/transformers/quicktour)
[Pipeline](https://huggingface.co/docs/transformers/pipeline_tutorial)
[Trainer](https://huggingface.co/docs/transformers/trainer)
[LLM course](https://huggingface.co/learn/llm-course/chapter1/1?fw=pt)
[Models Timeline](https://huggingface.co/docs/transformers/models_timeline)
[Parameter-efficient fine-tuning](https://huggingface.co/docs/transformers/peft)
[Pipeline](https://huggingface.co/docs/transformers/v5.5.4/en/main_classes/pipelines#transformers.Pipeline)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://huggingface.co/docs/transformers/index",
      "Summarize the main sections visible on the page that would help a new user get started.",
    )).toEqual([
      { text: "Installation", url: "https://huggingface.co/docs/transformers/installation" },
      { text: "Quickstart", url: "https://huggingface.co/docs/transformers/quicktour" },
      { text: "Pipeline", url: "https://huggingface.co/docs/transformers/pipeline_tutorial" },
      { text: "Trainer", url: "https://huggingface.co/docs/transformers/trainer" },
      { text: "LLM course", url: "https://huggingface.co/learn/llm-course/chapter1/1?fw=pt" },
      { text: "Models Timeline", url: "https://huggingface.co/docs/transformers/models_timeline" },
      { text: "Parameter-efficient fine-tuning", url: "https://huggingface.co/docs/transformers/peft" },
    ]);
  });

  test("canonicalizes hugging face model links into a cleaner follow-up set", () => {
    const markdown = `
[Files Files and versions xet](https://huggingface.co/google-bert/bert-base-uncased/tree/main)
[Community 99](https://huggingface.co/google-bert/bert-base-uncased/discussions)
[this paper](https://arxiv.org/abs/1810.04805)
[this repository](https://github.com/google-research/bert)
[google-research/bert readme](https://github.com/google-research/bert/blob/master/README.md)
[Fill-Mask](https://huggingface.co/tasks/fill-mask)
[BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding Paper • 1810.04805 • Published Oct 11, 2018 • 26](https://huggingface.co/papers/1810.04805)
[model hub](https://huggingface.co/models?filter=bert)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://huggingface.co/google-bert/bert-base-uncased",
      "Summarize this model and include the main model-card links.",
    )).toEqual([
      { text: "Files and versions", url: "https://huggingface.co/google-bert/bert-base-uncased/tree/main" },
      { text: "Community", url: "https://huggingface.co/google-bert/bert-base-uncased/discussions" },
      { text: "Paper", url: "https://arxiv.org/abs/1810.04805" },
      { text: "Source repository", url: "https://github.com/google-research/bert" },
      { text: "Repository README", url: "https://github.com/google-research/bert/blob/master/README.md" },
      { text: "Task: Fill-Mask", url: "https://huggingface.co/tasks/fill-mask" },
      { text: "Paper summary", url: "https://huggingface.co/papers/1810.04805" },
      { text: "Fine-tuned models", url: "https://huggingface.co/models?filter=bert" },
    ]);
  });

  test("extracts high-value URLs from JSON metadata", () => {
    const data = {
      info: {
        project_urls: {
          Documentation: "https://requests.readthedocs.io/",
          Homepage: "https://requests.readthedocs.io",
          Source: "https://github.com/psf/requests",
          Tracker: "https://github.com/psf/requests/issues",
        },
        project_url: "https://pypi.org/project/requests/",
        release_url: "https://pypi.org/project/requests/2.33.1/",
      },
    };

    expect(extractRelevantLinksFromJson(
      data,
      "https://pypi.org/pypi/requests/json",
      "Summarize package metadata and include project URLs.",
    )).toEqual([
      { text: "Documentation", url: "https://requests.readthedocs.io/" },
      { text: "Homepage", url: "https://requests.readthedocs.io" },
      { text: "Source", url: "https://github.com/psf/requests" },
      { text: "Tracker", url: "https://github.com/psf/requests/issues" },
      { text: "Package page", url: "https://pypi.org/project/requests/" },
      { text: "Release page", url: "https://pypi.org/project/requests/2.33.1/" },
    ]);
  });

  test("prefers see-also links on wikipedia pages", () => {
    const markdown = `
# Attention (machine learning)

Intro text.

## See also
[Recurrent neural network](https://en.wikipedia.org/wiki/Recurrent_neural_network)
- [seq2seq](https://en.wikipedia.org/wiki/Seq2seq)
- [Transformer (deep learning architecture)](https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture))
- [Attention](https://en.wikipedia.org/wiki/Attention)
- [Dynamic neural network](https://en.wikipedia.org/wiki/Dynamic_neural_network)

## References
`;

    expect(extractRelevantLinks(
      markdown,
      "https://en.wikipedia.org/wiki/Attention_(machine_learning)",
      "Summarize the article and preserve key related concepts.",
    )).toEqual([
      { text: "Recurrent neural network", url: "https://en.wikipedia.org/wiki/Recurrent_neural_network" },
      { text: "seq2seq", url: "https://en.wikipedia.org/wiki/Seq2seq" },
      { text: "Transformer (deep learning architecture)", url: "https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)" },
      { text: "Attention", url: "https://en.wikipedia.org/wiki/Attention" },
      { text: "Dynamic neural network", url: "https://en.wikipedia.org/wiki/Dynamic_neural_network" },
    ]);
  });

  test("selects useful docs.rs follow-up links", () => {
    const markdown = `
[Trait Deserialize](https://docs.rs/serde/latest/serde/trait.Deserialize.html)
[Trait Serialize](https://docs.rs/serde/latest/serde/trait.Serialize.html)
[Trait Deserializer](https://docs.rs/serde/latest/serde/trait.Deserializer.html)
[Trait Serializer](https://docs.rs/serde/latest/serde/trait.Serializer.html)
[Derive macro Deserialize](https://docs.rs/serde/latest/serde/derive.Deserialize.html)
[Derive macro Serialize](https://docs.rs/serde/latest/serde/derive.Serialize.html)
[Feature flags](https://docs.rs/crate/serde/latest/features)
[Source](https://docs.rs/crate/serde/latest/source/)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://docs.rs/serde/latest/serde/",
      "Summarize the docs page and suggest useful next steps.",
    )).toEqual([
      { text: "Trait: Deserialize", url: "https://docs.rs/serde/latest/serde/trait.Deserialize.html" },
      { text: "Trait: Serialize", url: "https://docs.rs/serde/latest/serde/trait.Serialize.html" },
      { text: "Trait: Deserializer", url: "https://docs.rs/serde/latest/serde/trait.Deserializer.html" },
      { text: "Trait: Serializer", url: "https://docs.rs/serde/latest/serde/trait.Serializer.html" },
      { text: "Derive macro: Deserialize", url: "https://docs.rs/serde/latest/serde/derive.Deserialize.html" },
      { text: "Derive macro: Serialize", url: "https://docs.rs/serde/latest/serde/derive.Serialize.html" },
      { text: "Feature flags", url: "https://docs.rs/crate/serde/latest/features" },
      { text: "Source", url: "https://docs.rs/crate/serde/latest/source/" },
    ]);
  });

  test("selects useful MDN follow-up links", () => {
    const markdown = `
[Using the Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch)
[Window.fetch()](https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch)
[Headers](https://developer.mozilla.org/en-US/docs/Web/API/Headers)
[Request](https://developer.mozilla.org/en-US/docs/Web/API/Request)
[Response](https://developer.mozilla.org/en-US/docs/Web/API/Response)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
      "Summarize the page and suggest the most useful learning links.",
    )).toEqual([
      { text: "Using the Fetch API", url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch" },
      { text: "Window.fetch()", url: "https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch" },
      { text: "Headers", url: "https://developer.mozilla.org/en-US/docs/Web/API/Headers" },
      { text: "Request", url: "https://developer.mozilla.org/en-US/docs/Web/API/Request" },
      { text: "Response", url: "https://developer.mozilla.org/en-US/docs/Web/API/Response" },
    ]);
  });

  test("selects useful RFC follow-up links", () => {
    const markdown = `
[RFC 9110 info](https://www.rfc-editor.org/info/rfc9110)
[RFC 9111](https://www.rfc-editor.org/rfc/rfc9111)
[RFC 9112](https://www.rfc-editor.org/rfc/rfc9112)
[RFC 9113](https://www.rfc-editor.org/rfc/rfc9113)
[RFC 9114](https://www.rfc-editor.org/rfc/rfc9114)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://www.rfc-editor.org/rfc/rfc9110",
      "Summarize the RFC and point to the most useful related documents.",
    )).toEqual([
      { text: "RFC 9110 info page", url: "https://www.rfc-editor.org/info/rfc9110" },
      { text: "RFC 9111: Caching", url: "https://www.rfc-editor.org/rfc/rfc9111" },
      { text: "RFC 9112: HTTP/1.1", url: "https://www.rfc-editor.org/rfc/rfc9112" },
      { text: "RFC 9113: HTTP/2", url: "https://www.rfc-editor.org/rfc/rfc9113" },
      { text: "RFC 9114: HTTP/3", url: "https://www.rfc-editor.org/rfc/rfc9114" },
    ]);
  });

  test("selects useful arXiv follow-up links", () => {
    const markdown = `
[View PDF](https://arxiv.org/pdf/1706.03762)
[HTML (experimental)](https://arxiv.org/html/1706.03762v7)
[DOI](https://doi.org/10.48550/arXiv.1706.03762)
[TeX Source](https://arxiv.org/src/1706.03762)
[[v6]](https://arxiv.org/abs/1706.03762v6)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://arxiv.org/abs/1706.03762",
      "Summarize the paper page and suggest the most useful follow-up links.",
    )).toEqual([
      { text: "View PDF", url: "https://arxiv.org/pdf/1706.03762" },
      { text: "HTML", url: "https://arxiv.org/html/1706.03762v7" },
      { text: "DOI", url: "https://doi.org/10.48550/arXiv.1706.03762" },
      { text: "TeX Source", url: "https://arxiv.org/src/1706.03762" },
      { text: "Latest version", url: "https://arxiv.org/abs/1706.03762v6" },
    ]);
  });

  test("selects useful Julia blog posts over site chrome", () => {
    const markdown = `
[Julia Programming Language](https://julialang.org/)
[This Month in Julia World (February 2026)](https://julialang.org/blog/2026/03/this-month-in-julia-world/)
[This Month in Julia World (December 2025)](https://julialang.org/blog/2026/01/this-month-in-julia-world/)
[Launching the Julia Security Working Group](https://julialang.org/blog/2025/11/launching-security-wg/)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://julialang.org/blog/",
      "Summarize the most prominent posts or sections visible on the page.",
    )).toEqual([
      { text: "This Month in Julia World (February 2026)", url: "https://julialang.org/blog/2026/03/this-month-in-julia-world/" },
      { text: "This Month in Julia World (December 2025)", url: "https://julialang.org/blog/2026/01/this-month-in-julia-world/" },
      { text: "Launching the Julia Security Working Group", url: "https://julialang.org/blog/2025/11/launching-security-wg/" },
    ]);
  });

  test("selects useful readthedocs getting-started links", () => {
    const markdown = `
[Installation of Requests](https://requests.readthedocs.io/en/latest/user/install/)
[Quickstart](https://requests.readthedocs.io/en/latest/user/quickstart/)
[Advanced Usage](https://requests.readthedocs.io/en/latest/user/advanced/)
[API Reference](https://requests.readthedocs.io/en/latest/api/)
[Authentication](https://requests.readthedocs.io/en/latest/user/authentication/)
[Bug Reports](https://requests.readthedocs.io/en/latest/dev/contributing/#bug-reports)
[Requests @ GitHub](https://github.com/psf/requests)
[Requests @ PyPI](https://pypi.org/project/requests/)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://requests.readthedocs.io/en/latest/",
      "Summarize the main sections visible on the page that would help a new user get started.",
    )).toEqual([
      { text: "Installation", url: "https://requests.readthedocs.io/en/latest/user/install/" },
      { text: "Quickstart", url: "https://requests.readthedocs.io/en/latest/user/quickstart/" },
      { text: "Advanced Usage", url: "https://requests.readthedocs.io/en/latest/user/advanced/" },
      { text: "API Reference", url: "https://requests.readthedocs.io/en/latest/api/" },
      { text: "Authentication", url: "https://requests.readthedocs.io/en/latest/user/authentication/" },
      { text: "Community Guide", url: "https://requests.readthedocs.io/en/latest/dev/contributing/" },
      { text: "GitHub", url: "https://github.com/psf/requests" },
      { text: "PyPI", url: "https://pypi.org/project/requests/" },
    ]);
  });

  test("selects a clean pandas docs landing-page set", () => {
    const markdown = `
[To the getting started guides](https://pandas.pydata.org/docs/getting_started/index.html#getting-started)
[To the user guide](https://pandas.pydata.org/docs/user_guide/index.html#user-guide)
[To the reference guide](https://pandas.pydata.org/docs/reference/index.html#api)
[To the development guide](https://pandas.pydata.org/docs/development/index.html#development)
[Release notes](https://pandas.pydata.org/docs/whatsnew/index.html)
[GitHub](https://github.com/pandas-dev/pandas)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://pandas.pydata.org/docs/",
      "Summarize the main sections visible on the page that would help a new user get started.",
    )).toEqual([
      { text: "Getting started", url: "https://pandas.pydata.org/docs/getting_started/index.html" },
      { text: "User Guide", url: "https://pandas.pydata.org/docs/user_guide/index.html" },
      { text: "API reference", url: "https://pandas.pydata.org/docs/reference/index.html" },
      { text: "Development", url: "https://pandas.pydata.org/docs/development/index.html" },
      { text: "Release notes", url: "https://pandas.pydata.org/docs/whatsnew/index.html" },
      { text: "Source Repository", url: "https://github.com/pandas-dev/pandas" },
    ]);
  });

  test("selects a clean fastapi docs getting-started set", () => {
    const markdown = `
[Features](https://fastapi.tiangolo.com/features/)
[Tutorial - User Guide](https://fastapi.tiangolo.com/tutorial/)
[First Steps](https://fastapi.tiangolo.com/tutorial/first-steps/)
[Concurrency and async / await](https://fastapi.tiangolo.com/async/)
[FastAPI CLI docs](https://fastapi.tiangolo.com/fastapi-cli/)
[Deployment](https://fastapi.tiangolo.com/deployment/)
[Reference](https://fastapi.tiangolo.com/reference/)
[fastapi/fastapi](https://github.com/fastapi/fastapi)
[Simple OAuth2 with Password and Bearer](https://fastapi.tiangolo.com/tutorial/security/simple-oauth2/)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://fastapi.tiangolo.com/",
      "Summarize the main sections visible on the page that would help a new user get started.",
    )).toEqual([
      { text: "Tutorial - User Guide", url: "https://fastapi.tiangolo.com/tutorial/" },
      { text: "First Steps", url: "https://fastapi.tiangolo.com/tutorial/first-steps/" },
      { text: "Features", url: "https://fastapi.tiangolo.com/features/" },
      { text: "Async / await", url: "https://fastapi.tiangolo.com/async/" },
      { text: "FastAPI CLI", url: "https://fastapi.tiangolo.com/fastapi-cli/" },
      { text: "Deployment", url: "https://fastapi.tiangolo.com/deployment/" },
      { text: "Reference", url: "https://fastapi.tiangolo.com/reference/" },
      { text: "GitHub", url: "https://github.com/fastapi/fastapi" },
    ]);
  });

  test("selects current posts on the python blog homepage", () => {
    const markdown = `
[Rust for CPython Progress Update April 2026](https://blog.python.org/2026/04/rust-for-cpython-2026-04)
[Python 3.15.0a8, 3.14.4 and 3.13.13 are out!](https://blog.python.org/2026/04/python-3150a8-3144-31313)
[The Python Insider Blog Has Moved!](https://blog.python.org/2026/03/the-python-insider-blog-has-moved)
[Browse all 312 posts](https://blog.python.org/blog)
[RSS](https://blog.python.org/rss.xml)
[Rust](https://blog.python.org/tags/Rust)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://blog.python.org/",
      "Summarize the most prominent posts or sections visible on the page.",
    )).toEqual([
      { text: "Rust for CPython Progress Update April 2026", url: "https://blog.python.org/2026/04/rust-for-cpython-2026-04" },
      { text: "Python 3.15.0a8, 3.14.4 and 3.13.13 are out!", url: "https://blog.python.org/2026/04/python-3150a8-3144-31313" },
      { text: "The Python Insider Blog Has Moved!", url: "https://blog.python.org/2026/03/the-python-insider-blog-has-moved" },
      { text: "Browse all posts", url: "https://blog.python.org/blog" },
      { text: "RSS", url: "https://blog.python.org/rss.xml" },
    ]);
  });

  test("selects useful whatwg spec anchors instead of issue links", () => {
    const markdown = `
[Preface](https://fetch.spec.whatwg.org/#preface)
[CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol)
[Fetch API](https://fetch.spec.whatwg.org/#fetch-api)
[Headers class](https://fetch.spec.whatwg.org/#headers-class)
[Request class](https://fetch.spec.whatwg.org/#request-class)
[Response class](https://fetch.spec.whatwg.org/#response-class)
[Background reading](https://fetch.spec.whatwg.org/#background-reading)
[Using fetch in other standards](https://fetch.spec.whatwg.org/#fetch-elsewhere)
[issue #1254](https://github.com/whatwg/fetch/issues/1254)
`;

    expect(extractRelevantLinks(
      markdown,
      "https://fetch.spec.whatwg.org/",
      "Summarize what this spec page is and which follow-up links seem most useful for a newcomer.",
    )).toEqual([
      { text: "Preface", url: "https://fetch.spec.whatwg.org/#preface" },
      { text: "CORS protocol", url: "https://fetch.spec.whatwg.org/#http-cors-protocol" },
      { text: "Fetch API", url: "https://fetch.spec.whatwg.org/#fetch-api" },
      { text: "Headers class", url: "https://fetch.spec.whatwg.org/#headers-class" },
      { text: "Request class", url: "https://fetch.spec.whatwg.org/#request-class" },
      { text: "Response class", url: "https://fetch.spec.whatwg.org/#response-class" },
      { text: "Background reading", url: "https://fetch.spec.whatwg.org/#background-reading" },
      { text: "Using fetch in other standards", url: "https://fetch.spec.whatwg.org/#fetch-elsewhere" },
    ]);
  });

  test("extracts bare URLs from plain-text pages when no markdown links are present", () => {
    const markdown = `We are unable to process your request. See https://crates.io/data-access for policy details.`;

    expect(extractRelevantLinks(
      markdown,
      "https://crates.io/crates/serde",
      "Summarize the page and keep any useful follow-up URLs.",
    )).toEqual([
      { text: "Data access policy", url: "https://crates.io/data-access" },
    ]);
  });

  test("builds a parseable Relevant Links section", () => {
    expect(buildRelevantLinksSection([
      { text: "PR #24046 fix", url: "https://github.com/iree-org/iree/pull/24046" },
      { text: "Issue #24035", url: "https://github.com/iree-org/iree/issues/24035" },
    ])).toBe([
      "## Relevant Links",
      "1. [PR #24046 fix](https://github.com/iree-org/iree/pull/24046)",
      "2. [Issue #24035](https://github.com/iree-org/iree/issues/24035)",
    ].join("\n"));
  });
});
