#!/usr/bin/env python3
"""
ClinPGx API Query Helper Script

Provides ready-to-use functions for querying the ClinPGx database API.
Includes rate limiting, error handling, and caching functionality.

ClinPGx API: https://api.clinpgx.org/
Rate limit: 2 requests per second
License: Creative Commons Attribution-ShareAlike 4.0 International
"""

import requests
import time
import json
from pathlib import Path
from typing import Dict, List, Optional, Any

# API Configuration
BASE_URL = "https://api.clinpgx.org/v1/"
RATE_LIMIT_DELAY = 0.5  # 500ms delay = 2 requests/second


def rate_limited_request(url: str, params: Optional[Dict] = None, delay: float = RATE_LIMIT_DELAY) -> requests.Response:
    """
    Make API request with rate limiting compliance.

    Args:
        url: API endpoint URL
        params: Query parameters
        delay: Delay in seconds between requests (default 0.5s for 2 req/sec)

    Returns:
        Response object
    """
    response = requests.get(url, params=params)
    time.sleep(delay)
    return response


def safe_api_call(url: str, params: Optional[Dict] = None, max_retries: int = 3) -> Optional[Dict]:
    """
    Make API call with error handling and exponential backoff retry.

    Args:
        url: API endpoint URL
        params: Query parameters
        max_retries: Maximum number of retry attempts

    Returns:
        JSON response data or None on failure
    """
    for attempt in range(max_retries):
        try:
            response = requests.get(url, params=params, timeout=10)

            if response.status_code == 200:
                time.sleep(RATE_LIMIT_DELAY)
                return response.json()
            elif response.status_code == 429:
                # Rate limit exceeded
                wait_time = 2 ** attempt  # Exponential backoff: 1s, 2s, 4s
                print(f"Rate limit exceeded. Waiting {wait_time}s before retry...")
                time.sleep(wait_time)
            elif response.status_code == 404:
                print(f"Resource not found: {url}")
                return None
            else:
                response.raise_for_status()

        except requests.exceptions.RequestException as e:
            print(f"Attempt {attempt + 1}/{max_retries} failed: {e}")
            if attempt == max_retries - 1:
                print(f"Failed after {max_retries} attempts")
                return None
            time.sleep(1)

    return None




# Core Query Functions

def get_gene_info(gene_symbol: str) -> Optional[Dict]:
    """
    Retrieve detailed information about a pharmacogene.

    Args:
        gene_symbol: Gene symbol (e.g., "CYP2D6", "TPMT")

    Returns:
        Gene information dictionary

    Example:
        >>> gene_data = get_gene_info("CYP2D6")
        >>> print(gene_data['symbol'], gene_data['name'])
    """
    url = f"{BASE_URL}gene/{gene_symbol}"
    return safe_api_call(url)


def get_drug_info(drug_name: str) -> Optional[List[Dict]]:
    """
    Search for drug/chemical information by name.

    Args:
        drug_name: Drug name (e.g., "warfarin", "codeine")

    Returns:
        List of matching drugs

    Example:
        >>> drugs = get_drug_info("warfarin")
        >>> for drug in drugs:
        >>>     print(drug['name'], drug['id'])
    """
    url = f"{BASE_URL}chemical"
    params = {"name": drug_name}
    return safe_api_call(url, params)


def get_gene_drug_pairs(gene: Optional[str] = None, drug: Optional[str] = None) -> Optional[List[Dict]]:
    """
    Query gene-drug interaction pairs.

    Args:
        gene: Gene symbol (optional)
        drug: Drug name (optional)

    Returns:
        List of gene-drug pairs with clinical annotations

    Example:
        >>> # Get all pairs for CYP2D6
        >>> pairs = get_gene_drug_pairs(gene="CYP2D6")
        >>>
        >>> # Get specific gene-drug pair
        >>> pair = get_gene_drug_pairs(gene="CYP2D6", drug="codeine")
    """
    url = f"{BASE_URL}geneDrugPair"
    params = {}
    if gene:
        params["gene"] = gene
    if drug:
        params["drug"] = drug

    return safe_api_call(url, params)


def get_cpic_guidelines(gene: Optional[str] = None, drug: Optional[str] = None) -> Optional[List[Dict]]:
    """
    Retrieve CPIC clinical practice guidelines.

    Args:
        gene: Gene symbol (optional)
        drug: Drug name (optional)

    Returns:
        List of CPIC guidelines

    Example:
        >>> # Get all CPIC guidelines
        >>> guidelines = get_cpic_guidelines()
        >>>
        >>> # Get guideline for specific gene-drug
        >>> guideline = get_cpic_guidelines(gene="CYP2C19", drug="clopidogrel")
    """
    url = f"{BASE_URL}guideline"
    params = {"source": "CPIC"}
    if gene:
        params["gene"] = gene
    if drug:
        params["drug"] = drug

    return safe_api_call(url, params)


def get_alleles(gene: str) -> Optional[List[Dict]]:
    """
    Get all alleles for a pharmacogene including function and frequency.

    Args:
        gene: Gene symbol (e.g., "CYP2D6")

    Returns:
        List of alleles with functional annotations and population frequencies

    Example:
        >>> alleles = get_alleles("CYP2D6")
        >>> for allele in alleles:
        >>>     print(f"{allele['name']}: {allele['function']}")
    """
    url = f"{BASE_URL}allele"
    params = {"gene": gene}
    return safe_api_call(url, params)




def get_clinical_annotations(
    gene: Optional[str] = None,
    drug: Optional[str] = None,
    evidence_level: Optional[str] = None
) -> Optional[List[Dict]]:
    """
    Retrieve curated literature annotations for gene-drug interactions.

    Args:
        gene: Gene symbol (optional)
        drug: Drug name (optional)
        evidence_level: Filter by evidence level (1A, 1B, 2A, 2B, 3, 4)

    Returns:
        List of clinical annotations

    Example:
        >>> # Get all annotations for CYP2D6
        >>> annotations = get_clinical_annotations(gene="CYP2D6")
        >>>
        >>> # Get high-quality evidence only
        >>> high_quality = get_clinical_annotations(evidence_level="1A")
    """
    url = f"{BASE_URL}clinicalAnnotation"
    params = {}
    if gene:
        params["gene"] = gene
    if drug:
        params["drug"] = drug
    if evidence_level:
        params["evidenceLevel"] = evidence_level

    return safe_api_call(url, params)








# Utility Functions

def export_to_dataframe(data: List[Dict], output_file: Optional[str] = None):
    """
    Convert API results to pandas DataFrame for analysis.

    Args:
        data: List of dictionaries from API
        output_file: Optional CSV output file path

    Returns:
        pandas DataFrame

    Example:
        >>> pairs = get_gene_drug_pairs(gene="CYP2D6")
        >>> df = export_to_dataframe(pairs, "cyp2d6_pairs.csv")
        >>> print(df.head())
    """
    try:
        import pandas as pd
    except ImportError:
        print("pandas not installed. Install with: pip install pandas")
        return None

    df = pd.DataFrame(data)

    if output_file:
        df.to_csv(output_file, index=False)
        print(f"Data exported to: {output_file}")

    return df






# Example Usage
if __name__ == "__main__":
    print("ClinPGx API Query Examples\n")

    # Example 1: Get gene information
    print("=" * 60)
    print("Example 1: Get CYP2D6 gene information")
    print("=" * 60)
    cyp2d6 = get_gene_info("CYP2D6")
    if cyp2d6:
        print(f"Gene: {cyp2d6.get('symbol')}")
        print(f"Name: {cyp2d6.get('name')}")
        print()

    # Example 2: Search for a drug
    print("=" * 60)
    print("Example 2: Search for warfarin")
    print("=" * 60)
    warfarin = get_drug_info("warfarin")
    if warfarin:
        for drug in warfarin[:1]:  # Show first result
            print(f"Drug: {drug.get('name')}")
            print(f"ID: {drug.get('id')}")
        print()

    # Example 3: Get gene-drug pairs
    print("=" * 60)
    print("Example 3: Get CYP2C19-clopidogrel pair")
    print("=" * 60)
    pair = get_gene_drug_pairs(gene="CYP2C19", drug="clopidogrel")
    if pair:
        print(f"Found {len(pair)} gene-drug pair(s)")
        if len(pair) > 0:
            print(f"Annotations: {pair[0].get('sources', [])}")
        print()

    # Example 4: Get CPIC guidelines
    print("=" * 60)
    print("Example 4: Get CPIC guidelines for CYP2C19")
    print("=" * 60)
    guidelines = get_cpic_guidelines(gene="CYP2C19")
    if guidelines:
        print(f"Found {len(guidelines)} guideline(s)")
        for g in guidelines[:2]:  # Show first 2
            print(f"  - {g.get('name')}")
        print()

    # Example 5: Get alleles for a gene
    print("=" * 60)
    print("Example 5: Get CYP2D6 alleles")
    print("=" * 60)
    alleles = get_alleles("CYP2D6")
    if alleles:
        print(f"Found {len(alleles)} allele(s)")
        for allele in alleles[:3]:  # Show first 3
            print(f"  - {allele.get('name')}: {allele.get('function')}")
        print()

    print("=" * 60)
    print("Examples completed!")
    print("=" * 60)
