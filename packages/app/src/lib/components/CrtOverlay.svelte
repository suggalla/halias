<div class="crt-overlay"></div>

<style>
	.crt-overlay {
		position: fixed;
		inset: 0;
		pointer-events: none;
		z-index: 999999;
		background:
			repeating-linear-gradient(
				0deg,
				rgba(0, 0, 0, 0.03) 0px,
				rgba(0, 0, 0, 0.03) 1px,
				transparent 1px,
				transparent 3px
			),
			radial-gradient(
				ellipse at center,
				transparent 60%,
				rgba(0, 0, 0, 0.3) 100%
			);
	}
</style>
