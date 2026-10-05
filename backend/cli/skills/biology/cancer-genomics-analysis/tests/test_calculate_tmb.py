"""TMB reporting with a real local VCF and cyvcf2 parser."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("calculate_tmb", Path(__file__).parents[1] / "scripts/calculate_tmb.py")
tmb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tmb)


def test_all_filtered_variants_report_zero_without_losing_counts(tmp_path, capsys):
    vcf = tmp_path / "filtered.vcf"
    vcf.write_text(
        '##fileformat=VCFv4.2\n'
        '##contig=<ID=1,length=1000>\n'
        '##INFO=<ID=DP,Number=1,Type=Integer,Description="Depth">\n'
        '##INFO=<ID=AF,Number=A,Type=Float,Description="Allele frequency">\n'
        '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n'
        '1\t10\t.\tA\tT\t50\tPASS\tDP=2;AF=0.5\n'
        '1\t20\t.\tG\tC\t50\tPASS\tDP=30;AF=0.01\n'
    )
    result = tmb.calculate_tmb(vcf)
    assert result["total_variants"] == 2
    assert result["passed_filters"] == 0
    assert result["filtered_out"] == 2
    assert result["tmb"] == 0
    tmb.print_tmb_report(result)
    assert "0.00" in capsys.readouterr().out
