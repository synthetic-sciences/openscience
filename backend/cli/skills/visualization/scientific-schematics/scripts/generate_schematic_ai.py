#!/usr/bin/env python3
"""
AI-powered scientific schematic generation using Nano Banana Pro.

This script uses a smart iterative refinement approach:
1. Generate initial image with Nano Banana Pro
2. AI quality review using Gemini 3 Pro for scientific critique
3. Only regenerate if quality is below threshold for document type
4. Repeat until quality meets standards (max iterations)

Requirements:
    - OPENROUTER_API_KEY environment variable
    - requests library

Usage:
    python generate_schematic_ai.py "Create a flowchart showing CONSORT participant flow" -o flowchart.png
    python generate_schematic_ai.py "Neural network architecture diagram" -o architecture.png --iterations 2
    python generate_schematic_ai.py "Simple block diagram" -o diagram.png --doc-type poster
"""

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


try:
    import requests
except ImportError:
    print("Error: requests library not found. Install with: pip install requests")
    sys.exit(1)


# Try to load .env file from multiple potential locations
def _load_env_file():
    """Load .env file from current directory, parent directories, or package directory.

    Returns True if a .env file was found and loaded, False otherwise.
    Note: This does NOT override existing environment variables.
    """
    try:
        from dotenv import load_dotenv
    except ImportError:
        return False  # python-dotenv not installed

    # Try current working directory first
    env_path = Path.cwd() / ".env"
    if env_path.exists():
        load_dotenv(dotenv_path=env_path, override=False)
        return True

    # Try parent directories (up to 5 levels)
    cwd = Path.cwd()
    for _ in range(5):
        env_path = cwd / ".env"
        if env_path.exists():
            load_dotenv(dotenv_path=env_path, override=False)
            return True
        cwd = cwd.parent
        if cwd == cwd.parent:  # Reached root
            break

    # Try the package's parent directory (scientific-writer project root)
    script_dir = Path(__file__).resolve().parent
    for _ in range(5):
        env_path = script_dir / ".env"
        if env_path.exists():
            load_dotenv(dotenv_path=env_path, override=False)
            return True
        script_dir = script_dir.parent
        if script_dir == script_dir.parent:
            break

    return False


def _synced_env() -> dict:
    """Read OpenScience's managed synced env (written by `openscience connect sync`).

    In managed mode this holds OPENROUTER_API_KEY (the managed thk_ token) and
    OPENROUTER_BASE_URL (the Atlas proxy), so generation can route through the
    managed key — billed to the user's wallet — without a user-provided key. The
    managed token is stripped from the subprocess env on purpose, so we read the
    file the CLI already persisted (same data, no broad env leak).
    """
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    try:
        with open(os.path.join(base, "openscience", "synced-env.json"), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


class ScientificSchematicGenerator:
    """Generate scientific schematics using AI with smart iterative refinement.

    Uses Nano Banana Pro (with Nano Banana Standard fallback) for generation
    and Gemini 3.1 Pro for quality review. Multiple passes only occur if the
    generated schematic doesn't meet the quality threshold for the target
    document type.
    """

    # Quality thresholds by document type (score out of 10)
    # Higher thresholds for more formal publications
    QUALITY_THRESHOLDS = {
        "journal": 8.5,  # Nature, Science, etc. - highest standards
        "conference": 8.0,  # Conference papers - high standards
        "poster": 7.0,  # Academic posters - good quality
        "presentation": 6.5,  # Slides/talks - clear but less formal
        "report": 7.5,  # Technical reports - professional
        "grant": 8.0,  # Grant proposals - must be compelling
        "thesis": 8.0,  # Dissertations - formal academic
        "preprint": 7.5,  # arXiv, etc. - good quality
        "default": 7.5,  # Default threshold
    }

    # Scientific diagram best practices prompt template
    SCIENTIFIC_DIAGRAM_GUIDELINES = """
Create a high-quality scientific diagram with these requirements:

VISUAL QUALITY:
- Clean white or light background (no textures or gradients)
- High contrast for readability and printing
- Professional, publication-ready appearance
- Sharp, clear lines and text
- Adequate spacing between elements to prevent crowding

TYPOGRAPHY:
- Clear, readable sans-serif fonts (Arial, Helvetica style)
- Minimum 10pt font size for all labels
- Consistent font sizes throughout
- All text horizontal or clearly readable
- No overlapping text

SCIENTIFIC STANDARDS:
- Accurate representation of concepts
- Clear labels for all components
- Include scale bars, legends, or axes where appropriate
- Use standard scientific notation and symbols
- Include units where applicable

ACCESSIBILITY:
- Colorblind-friendly color palette (use Okabe-Ito colors if using color)
- High contrast between elements
- Redundant encoding (shapes + colors, not just colors)
- Works well in grayscale

LAYOUT:
- Logical flow (left-to-right or top-to-bottom)
- Clear visual hierarchy
- Balanced composition
- Appropriate use of whitespace
- No clutter or unnecessary decorative elements
"""

    def __init__(self, api_key: Optional[str] = None, verbose: bool = False):
        """
        Initialize the generator.

        Args:
            api_key: OpenRouter API key (or use OPENROUTER_API_KEY env var)
            verbose: Print detailed progress information
        """
        # Priority: 1) explicit param, 2) env var, 3) .env file, 4) OpenScience managed credential
        synced = _synced_env()
        self.api_key = api_key or os.getenv("OPENROUTER_API_KEY")

        # If not found in environment, try loading from .env file
        if not self.api_key:
            _load_env_file()
            self.api_key = os.getenv("OPENROUTER_API_KEY")

        # Fall back to the OpenScience managed credential (routes through the Atlas
        # proxy, billed to the user's wallet) so generation works without a
        # user-provided key.
        if not self.api_key:
            self.api_key = synced.get("OPENROUTER_API_KEY")

        if not self.api_key:
            raise ValueError(
                "OPENROUTER_API_KEY not found. Connect OpenRouter via `openscience login` or at\n"
                "https://app.syntheticsciences.ai → Services, or set OPENROUTER_API_KEY for this run.\n"
                "Get your own key from: https://openrouter.ai/keys"
            )

        self.verbose = verbose
        self._last_error = None  # Track last error for better reporting
        # Honor OPENROUTER_BASE_URL (managed/proxied routes); default to public OpenRouter.
        # Use the managed proxy base only when the key itself came from the managed
        # synced env — a BYOK key must hit public OpenRouter, not the proxy.
        managed_base = synced.get("OPENROUTER_BASE_URL") if self.api_key == synced.get("OPENROUTER_API_KEY") else None
        self.base_url = (os.getenv("OPENROUTER_BASE_URL") or managed_base or "https://openrouter.ai/api/v1").rstrip("/")
        # Image generation models in priority order (fallback if primary fails).
        # Nano Banana Pro (Gemini 3 Pro Image) — GA first, then the preview slug
        # (retires 2026-06-25), then Nano Banana Standard as a last resort.
        self.image_models = [
            os.getenv("OPENROUTER_IMAGE_MODEL") or "google/gemini-3-pro-image",  # Nano Banana Pro (GA)
            "google/gemini-3-pro-image-preview",  # Nano Banana Pro (preview fallback)
            "google/gemini-2.5-flash-image",      # Nano Banana Standard (fallback)
        ]
        self.image_model = self.image_models[0]
        # Gemini 3 Pro for quality review - excellent vision and reasoning
        self.review_model = os.getenv("OPENROUTER_REVIEW_MODEL") or "google/gemini-3-pro"

    def _log(self, message: str):
        """Log message if verbose mode is enabled."""
        if self.verbose:
            print(f"[{time.strftime('%H:%M:%S')}] {message}")

    def _make_request(
        self, model: str, messages: List[Dict[str, Any]], modalities: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Make a request to OpenRouter API.

        Args:
            model: Model identifier
            messages: List of message dictionaries
            modalities: Optional list of modalities (e.g., ["image", "text"])

        Returns:
            API response as dictionary
        """
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/scientific-writer",
            "X-Title": "Scientific Schematic Generator",
        }

        payload = {"model": model, "messages": messages}

        if modalities:
            payload["modalities"] = modalities

        self._log(f"Making request to {model}...")

        try:
            response = requests.post(f"{self.base_url}/chat/completions", headers=headers, json=payload, timeout=120)

            # Try to get response body even on error
            try:
                response_json = response.json()
            except json.JSONDecodeError:
                response_json = {"raw_text": response.text[:500]}

            # Check for HTTP errors but include response body in error message
            if response.status_code != 200:
                error_detail = response_json.get("error", response_json)
                self._log(f"HTTP {response.status_code}: {error_detail}")
                raise RuntimeError(f"API request failed (HTTP {response.status_code}): {error_detail}")

            return response_json
        except requests.exceptions.Timeout:
            raise RuntimeError("API request timed out after 120 seconds")
        except requests.exceptions.RequestException as e:
            raise RuntimeError(f"API request failed: {str(e)}")

    def _extract_image_from_response(self, response: Dict[str, Any]) -> Optional[bytes]:
        """
        Extract base64-encoded image from API response.

        For Nano Banana Pro, images are returned in the 'images' field of the message,
        not in the 'content' field.

        Args:
            response: API response dictionary

        Returns:
            Image bytes or None if not found
        """
        try:
            choices = response.get("choices", [])
            if not choices:
                self._log("No choices in response")
                return None

            message = choices[0].get("message", {})

            # IMPORTANT: Nano Banana Pro returns images in the 'images' field
            images = message.get("images", [])
            if images and len(images) > 0:
                self._log(f"Found {len(images)} image(s) in 'images' field")

                # Get first image
                first_image = images[0]
                if isinstance(first_image, dict):
                    # Extract image_url
                    if first_image.get("type") == "image_url":
                        url = first_image.get("image_url", {})
                        if isinstance(url, dict):
                            url = url.get("url", "")

                        if url and url.startswith("data:image"):
                            # Extract base64 data after comma
                            if "," in url:
                                base64_str = url.split(",", 1)[1]
                                # Clean whitespace
                                base64_str = base64_str.replace('\n', '').replace('\r', '').replace(' ', '')
                                self._log(f"Extracted base64 data (length: {len(base64_str)})")
                                return base64.b64decode(base64_str)

            # Fallback: check content field (for other models or future changes)
            content = message.get("content", "")

            if self.verbose:
                self._log(f"Content type: {type(content)}, length: {len(str(content))}")

            # Handle string content
            if isinstance(content, str) and "data:image" in content:
                import re

                match = re.search(r'data:image/[^;]+;base64,([A-Za-z0-9+/=\n\r]+)', content, re.DOTALL)
                if match:
                    base64_str = match.group(1).replace('\n', '').replace('\r', '').replace(' ', '')
                    self._log(f"Found image in content field (length: {len(base64_str)})")
                    return base64.b64decode(base64_str)

            # Handle list content
            if isinstance(content, list):
                for i, block in enumerate(content):
                    if isinstance(block, dict) and block.get("type") == "image_url":
                        url = block.get("image_url", {})
                        if isinstance(url, dict):
                            url = url.get("url", "")
                        if url and url.startswith("data:image") and "," in url:
                            base64_str = url.split(",", 1)[1].replace('\n', '').replace('\r', '').replace(' ', '')
                            self._log(f"Found image in content block {i}")
                            return base64.b64decode(base64_str)

            self._log("No image data found in response")
            return None

        except Exception as e:
            self._log(f"Error extracting image: {str(e)}")
            import traceback

            if self.verbose:
                traceback.print_exc()
            return None

    def _image_to_base64(self, image_path: str) -> str:
        """
        Convert image file to base64 data URL.

        Args:
            image_path: Path to image file

        Returns:
            Base64 data URL string
        """
        with open(image_path, "rb") as f:
            image_data = f.read()

        # Determine image type from extension
        ext = Path(image_path).suffix.lower()
        mime_type = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
        }.get(ext, "image/png")

        base64_data = base64.b64encode(image_data).decode("utf-8")
        return f"data:{mime_type};base64,{base64_data}"

    def _diagnose_response(self, response: Dict[str, Any], model: str):
        """Print diagnostic info when image extraction fails."""
        print(f"  [diagnostic] Model: {model}")
        if "error" in response:
            print(f"  [diagnostic] API error: {response['error']}")
        if "choices" in response and response["choices"]:
            msg = response["choices"][0].get("message", {})
            print(f"  [diagnostic] Message keys: {list(msg.keys())}")
            finish = response["choices"][0].get("finish_reason", "unknown")
            print(f"  [diagnostic] Finish reason: {finish}")
            content = msg.get("content", "")
            if isinstance(content, str):
                preview = content[:300] + "..." if len(content) > 300 else content
                if preview:
                    print(f"  [diagnostic] Content: {preview}")
            elif isinstance(content, list):
                print(f"  [diagnostic] Content is list with {len(content)} items:")
                for i, item in enumerate(content[:5]):
                    if isinstance(item, dict):
                        print(f"    Item {i}: type={item.get('type')}, keys={list(item.keys())}")
            images = msg.get("images", [])
            if images:
                print(f"  [diagnostic] Images field: {len(images)} items")
            reasoning = msg.get("reasoning", "")
            if reasoning:
                preview = reasoning[:200] + "..." if len(reasoning) > 200 else reasoning
                print(f"  [diagnostic] Reasoning: {preview}")
        else:
            print(f"  [diagnostic] Response keys: {list(response.keys())}")
            # Show raw response preview (truncated)
            raw = json.dumps(response)[:500]
            print(f"  [diagnostic] Raw response: {raw}")

    def _try_generate_with_model(self, model: str, messages: List[Dict[str, Any]]) -> Optional[bytes]:
        """Try to generate an image with a specific model. Returns image bytes or None."""
        try:
            response = self._make_request(model=model, messages=messages, modalities=["image", "text"])

            # Check for API errors in response body
            if "error" in response:
                error_msg = response["error"]
                if isinstance(error_msg, dict):
                    error_msg = error_msg.get("message", str(error_msg))
                print(f"  ✗ {model}: API error — {error_msg}")
                return None

            image_data = self._extract_image_from_response(response)
            if image_data:
                self._log(f"✓ Generated image with {model} ({len(image_data)} bytes)")
                return image_data

            # Image extraction failed — print diagnostics
            print(f"  ✗ {model}: No image data in response")
            self._diagnose_response(response, model)
            return None

        except RuntimeError as e:
            print(f"  ✗ {model}: {str(e)}")
            return None
        except Exception as e:
            print(f"  ✗ {model}: Unexpected error — {str(e)}")
            if self.verbose:
                import traceback
                traceback.print_exc()
            return None

    def generate_image(self, prompt: str) -> Optional[bytes]:
        """
        Generate an image using available image models with automatic fallback.

        Tries each model in priority order. If the primary model fails or returns
        no image data, falls back to the next model.

        Args:
            prompt: Description of the diagram to generate

        Returns:
            Image bytes or None if all models failed
        """
        self._last_error = None

        messages = [{"role": "user", "content": prompt}]

        for model in self.image_models:
            self._log(f"Trying {model}...")
            image_data = self._try_generate_with_model(model, messages)
            if image_data:
                self.image_model = model  # Track which model succeeded
                return image_data

        self._last_error = f"All image models failed: {', '.join(self.image_models)}"
        return None

    def review_image(
        self, image_path: str, original_prompt: str, iteration: int, doc_type: str = "default", max_iterations: int = 2
    ) -> Tuple[str, float, bool]:
        """
        Review generated image using Gemini 3 Pro for quality analysis.

        Uses Gemini 3 Pro's superior vision and reasoning capabilities to
        evaluate the schematic quality and determine if regeneration is needed.

        Args:
            image_path: Path to the generated image
            original_prompt: Original user prompt
            iteration: Current iteration number
            doc_type: Document type (journal, poster, presentation, etc.)
            max_iterations: Maximum iterations allowed

        Returns:
            Tuple of (critique text, quality score 0-10, needs_improvement bool)
        """
        # Use Gemini 3 Pro for review - excellent vision and analysis
        image_data_url = self._image_to_base64(image_path)

        # Get quality threshold for this document type
        threshold = self.QUALITY_THRESHOLDS.get(doc_type.lower(), self.QUALITY_THRESHOLDS["default"])

        review_prompt = f"""You are an expert reviewer evaluating a scientific diagram for publication quality.

ORIGINAL REQUEST: {original_prompt}

DOCUMENT TYPE: {doc_type} (quality threshold: {threshold}/10)
ITERATION: {iteration}/{max_iterations}

Carefully evaluate this diagram on these criteria:

1. **Scientific Accuracy** (0-2 points)
   - Correct representation of concepts
   - Proper notation and symbols
   - Accurate relationships shown

2. **Clarity and Readability** (0-2 points)
   - Easy to understand at a glance
   - Clear visual hierarchy
   - No ambiguous elements

3. **Label Quality** (0-2 points)
   - All important elements labeled
   - Labels are readable (appropriate font size)
   - Consistent labeling style

4. **Layout and Composition** (0-2 points)
   - Logical flow (top-to-bottom or left-to-right)
   - Balanced use of space
   - No overlapping elements

5. **Professional Appearance** (0-2 points)
   - Publication-ready quality
   - Clean, crisp lines and shapes
   - Appropriate colors/contrast

RESPOND IN THIS EXACT FORMAT:
SCORE: [total score 0-10]

STRENGTHS:
- [strength 1]
- [strength 2]

ISSUES:
- [issue 1 if any]
- [issue 2 if any]

VERDICT: [ACCEPTABLE or NEEDS_IMPROVEMENT]

If score >= {threshold}, the diagram is ACCEPTABLE for {doc_type} publication.
If score < {threshold}, mark as NEEDS_IMPROVEMENT with specific suggestions."""

        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": review_prompt},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ],
            }
        ]

        try:
            # Use Gemini 3 Pro for high-quality review
            response = self._make_request(model=self.review_model, messages=messages)

            # Extract text response
            choices = response.get("choices", [])
            if not choices:
                return "Image generated successfully", 8.0

            message = choices[0].get("message", {})
            content = message.get("content", "")

            # Check reasoning field (Nano Banana Pro puts analysis here)
            reasoning = message.get("reasoning", "")
            if reasoning and not content:
                content = reasoning

            if isinstance(content, list):
                # Extract text from content blocks
                text_parts = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text_parts.append(block.get("text", ""))
                content = "\n".join(text_parts)

            # Try to extract score
            score = 7.5  # Default score if extraction fails
            import re

            # Look for SCORE: X or SCORE: X/10 format
            score_match = re.search(r'SCORE:\s*(\d+(?:\.\d+)?)', content, re.IGNORECASE)
            if score_match:
                score = float(score_match.group(1))
            else:
                # Fallback: look for any score pattern
                score_match = re.search(
                    r'(?:score|rating|quality)[:\s]+(\d+(?:\.\d+)?)\s*(?:/\s*10)?', content, re.IGNORECASE
                )
                if score_match:
                    score = float(score_match.group(1))

            # Determine if improvement is needed based on verdict or score
            needs_improvement = False
            if "NEEDS_IMPROVEMENT" in content.upper():
                needs_improvement = True
            elif score < threshold:
                needs_improvement = True

            self._log(f"✓ Review complete (Score: {score}/10, Threshold: {threshold}/10)")
            self._log(f"  Verdict: {'Needs improvement' if needs_improvement else 'Acceptable'}")

            return (content if content else "Image generated successfully", score, needs_improvement)
        except Exception as e:
            self._log(f"Review skipped: {str(e)}")
            # Don't fail the whole process if review fails - assume acceptable
            return "Image generated successfully (review skipped)", 7.5, False

    def improve_prompt(self, original_prompt: str, critique: str, iteration: int) -> str:
        """
        Improve the generation prompt based on critique.

        Args:
            original_prompt: Original user prompt
            critique: Review critique from previous iteration
            iteration: Current iteration number

        Returns:
            Improved prompt for next generation
        """
        improved_prompt = f"""{self.SCIENTIFIC_DIAGRAM_GUIDELINES}

USER REQUEST: {original_prompt}

ITERATION {iteration}: Based on previous feedback, address these specific improvements:
{critique}

Generate an improved version that addresses all the critique points while maintaining scientific accuracy and professional quality."""

        return improved_prompt

    def generate_iterative(
        self, user_prompt: str, output_path: str, iterations: int = 2, doc_type: str = "default"
    ) -> Dict[str, Any]:
        """
        Generate scientific schematic with smart iterative refinement.

        Only regenerates if the quality score is below the threshold for the
        specified document type. This saves API calls and time when the first
        generation is already good enough.

        Args:
            user_prompt: User's description of desired diagram
            output_path: Path to save final image
            iterations: Maximum refinement iterations (default: 2, max: 2)
            doc_type: Document type for quality threshold (journal, poster, etc.)

        Returns:
            Dictionary with generation results and metadata
        """
        output_path = Path(output_path)
        output_dir = output_path.parent
        output_dir.mkdir(parents=True, exist_ok=True)

        base_name = output_path.stem
        extension = output_path.suffix or ".png"

        # Get quality threshold for this document type
        threshold = self.QUALITY_THRESHOLDS.get(doc_type.lower(), self.QUALITY_THRESHOLDS["default"])

        results = {
            "user_prompt": user_prompt,
            "doc_type": doc_type,
            "quality_threshold": threshold,
            "iterations": [],
            "final_image": None,
            "final_score": 0.0,
            "success": False,
            "early_stop": False,
            "early_stop_reason": None,
        }

        current_prompt = f"""{self.SCIENTIFIC_DIAGRAM_GUIDELINES}

USER REQUEST: {user_prompt}

Generate a publication-quality scientific diagram that meets all the guidelines above."""

        print(f"\n{'=' * 60}")
        print("Generating Scientific Schematic")
        print(f"{'=' * 60}")
        print(f"Description: {user_prompt}")
        print(f"Document Type: {doc_type}")
        print(f"Quality Threshold: {threshold}/10")
        print(f"Max Iterations: {iterations}")
        print(f"Image Models: {' → '.join(self.image_models)}")
        print(f"Review Model: {self.review_model}")
        print(f"Output: {output_path}")
        print(f"{'=' * 60}\n")

        for i in range(1, iterations + 1):
            print(f"\n[Iteration {i}/{iterations}]")
            print("-" * 40)

            # Generate image
            print("Generating image...")
            image_data = self.generate_image(current_prompt)

            if not image_data:
                error_msg = getattr(self, '_last_error', 'Image generation failed - no image data returned')
                print(f"✗ Generation failed: {error_msg}")
                results["iterations"].append({"iteration": i, "success": False, "error": error_msg})
                continue

            # Save iteration image
            iter_path = output_dir / f"{base_name}_v{i}{extension}"
            with open(iter_path, "wb") as f:
                f.write(image_data)
            print(f"✓ Saved: {iter_path}")

            # Review image using Gemini 3 Pro
            print(f"Reviewing image with {self.review_model}...")
            critique, score, needs_improvement = self.review_image(str(iter_path), user_prompt, i, doc_type, iterations)
            print(f"✓ Score: {score}/10 (threshold: {threshold}/10)")

            # Save iteration results
            iteration_result = {
                "iteration": i,
                "image_path": str(iter_path),
                "prompt": current_prompt,
                "critique": critique,
                "score": score,
                "needs_improvement": needs_improvement,
                "success": True,
            }
            results["iterations"].append(iteration_result)

            # Check if quality is acceptable - STOP EARLY if so
            if not needs_improvement:
                print(f"\n✓ Quality meets {doc_type} threshold ({score} >= {threshold})")
                print("  No further iterations needed!")
                results["final_image"] = str(iter_path)
                results["final_score"] = score
                results["success"] = True
                results["early_stop"] = True
                results["early_stop_reason"] = f"Quality score {score} meets threshold {threshold} for {doc_type}"
                break

            # If this is the last iteration, we're done regardless
            if i == iterations:
                print("\n⚠ Maximum iterations reached")
                results["final_image"] = str(iter_path)
                results["final_score"] = score
                results["success"] = True
                break

            # Quality below threshold - improve prompt for next iteration
            print(f"\n⚠ Quality below threshold ({score} < {threshold})")
            print("Improving prompt based on feedback...")
            current_prompt = self.improve_prompt(user_prompt, critique, i + 1)

        # Copy final version to output path
        if results["success"] and results["final_image"]:
            final_iter_path = Path(results["final_image"])
            if final_iter_path != output_path:
                import shutil

                shutil.copy(final_iter_path, output_path)
                print(f"\n✓ Final image: {output_path}")

        # Save review log
        log_path = output_dir / f"{base_name}_review_log.json"
        with open(log_path, "w") as f:
            json.dump(results, f, indent=2)
        print(f"✓ Review log: {log_path}")

        print(f"\n{'=' * 60}")
        print("Generation Complete!")
        print(f"Final Score: {results['final_score']}/10")
        if results["early_stop"]:
            print(
                f"Iterations Used: {len([r for r in results['iterations'] if r.get('success')])}/{iterations} (early stop)"
            )
        print(f"{'=' * 60}\n")

        return results


def main():
    """Command-line interface."""
    parser = argparse.ArgumentParser(
        description="Generate scientific schematics using AI with smart iterative refinement",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate a flowchart for a journal paper
  python generate_schematic_ai.py "CONSORT participant flow diagram" -o flowchart.png --doc-type journal
  
  # Generate neural network architecture for presentation (lower threshold)
  python generate_schematic_ai.py "Transformer encoder-decoder architecture" -o transformer.png --doc-type presentation
  
  # Generate with custom max iterations for poster
  python generate_schematic_ai.py "Biological signaling pathway" -o pathway.png --iterations 2 --doc-type poster
  
  # Verbose output
  python generate_schematic_ai.py "Circuit diagram" -o circuit.png -v

Document Types (quality thresholds):
  journal      8.5/10  - Nature, Science, peer-reviewed journals
  conference   8.0/10  - Conference papers
  thesis       8.0/10  - Dissertations, theses
  grant        8.0/10  - Grant proposals
  preprint     7.5/10  - arXiv, bioRxiv, etc.
  report       7.5/10  - Technical reports
  poster       7.0/10  - Academic posters
  presentation 6.5/10  - Slides, talks
  default      7.5/10  - General purpose

Note: Multiple iterations only occur if quality is BELOW the threshold.
      If the first generation meets the threshold, no extra API calls are made.

Environment:
  OPENROUTER_API_KEY    OpenRouter API key (required)
        """,
    )

    parser.add_argument("prompt", help="Description of the diagram to generate")
    parser.add_argument("-o", "--output", required=True, help="Output image path (e.g., diagram.png)")
    parser.add_argument("--iterations", type=int, default=2, help="Maximum refinement iterations (default: 2, max: 2)")
    parser.add_argument(
        "--doc-type",
        default="default",
        choices=["journal", "conference", "poster", "presentation", "report", "grant", "thesis", "preprint", "default"],
        help="Document type for quality threshold (default: default)",
    )
    parser.add_argument("--api-key", help="OpenRouter API key (or set OPENROUTER_API_KEY)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose output")

    args = parser.parse_args()

    # Check for API key
    api_key = args.api_key or os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        print("Error: OPENROUTER_API_KEY environment variable not set")
        print("\nSet it with:")
        print("  export OPENROUTER_API_KEY='your_api_key'")
        print("\nOr provide via --api-key flag")
        sys.exit(1)

    # Validate iterations - enforce max of 2
    if args.iterations < 1 or args.iterations > 2:
        print("Error: Iterations must be between 1 and 2")
        sys.exit(1)

    try:
        generator = ScientificSchematicGenerator(api_key=api_key, verbose=args.verbose)
        results = generator.generate_iterative(
            user_prompt=args.prompt, output_path=args.output, iterations=args.iterations, doc_type=args.doc_type
        )

        if results["success"]:
            print(f"\n✓ Success! Image saved to: {args.output}")
            if results.get("early_stop"):
                print(
                    f"  (Completed in {len([r for r in results['iterations'] if r.get('success')])} iteration(s) - quality threshold met)"
                )
            sys.exit(0)
        else:
            print("\n✗ Generation failed. Check review log for details.")
            sys.exit(1)
    except Exception as e:
        print(f"\n✗ Error: {str(e)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
